import { processConcurrencyGate, spawnInteractiveProcess } from "./process-runner.ts";

type InteractiveProcess = ReturnType<typeof spawnInteractiveProcess>;

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const HOT_COMMANDS = new Set([
  "assembly-tree",
  "build",
  "capability",
  "compare",
  "export",
  "inspect",
  "inspect-interference",
  "inspect-surfaces",
  "measure",
  "mesh",
  "render",
  "scan-sections",
  "section",
]);

export interface WarmCadctlLaunch {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WarmCadctlRequest {
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface WarmCadctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationReason?: undefined;
  terminationDetail?: undefined;
}

interface WorkerFrame extends WarmCadctlResult {
  id: number;
  workerPid: number;
}

interface PendingRequest {
  id: number;
  timer: NodeJS.Timeout;
  resolve(value: WarmCadctlResult): void;
  reject(error: Error): void;
}

export function isWarmCadctlCommand(command: string | undefined): boolean {
  return !!command && HOT_COMMANDS.has(command);
}

class WarmCadctlWorker {
  private child: InteractiveProcess | null = null;
  private pending: PendingRequest | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private requestId = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly launch: WarmCadctlLaunch,
    private readonly onClose: () => void,
  ) {}

  run(request: WarmCadctlRequest): Promise<WarmCadctlResult> {
    const task = this.queue.then(() => this.runOne(request), () => this.runOne(request));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  stop(reason = "cadctl worker stopped"): void {
    const child = this.child;
    this.child = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
    }
    this.onClose();
  }

  private async runOne(request: WarmCadctlRequest): Promise<WarmCadctlResult> {
    const release = await processConcurrencyGate.acquire();
    try {
      const child = this.ensureChild();
      this.setReferenced(child, true);
      const id = ++this.requestId;
      return await new Promise<WarmCadctlResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error(`cadctl worker timed out after ${request.timeoutMs}ms`));
          this.stop("cadctl worker timed out");
        }, request.timeoutMs);
        timer.unref();
        this.pending = {
          id,
          timer,
          resolve: (result) => {
            if (Buffer.byteLength(result.stdout) > request.maxStdoutBytes) {
              reject(new Error("cadctl worker stdout exceeded its limit"));
              return;
            }
            if (Buffer.byteLength(result.stderr) > request.maxStderrBytes) {
              reject(new Error("cadctl worker stderr exceeded its limit"));
              return;
            }
            resolve(result);
          },
          reject,
        };
        const payload = `${JSON.stringify({ id, args: request.args, cwd: request.cwd, timeoutMs: request.timeoutMs })}\n`;
        child.stdin.write(payload, "utf-8", (error) => {
          if (!error || this.pending?.id !== id) return;
          clearTimeout(timer);
          this.pending = null;
          reject(error);
          this.stop("cadctl worker input failed");
        });
      });
    } finally {
      if (this.child) this.setReferenced(this.child, false);
      release();
    }
  }

  private ensureChild(): InteractiveProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawnInteractiveProcess({
      command: this.launch.command,
      args: this.launch.args,
      cwd: this.launch.cwd,
      env: this.launch.env,
    });
    this.child = child;
    workerStats.starts += 1;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-8192);
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(new Error(`cadctl worker exited with ${code ?? signal ?? "unknown status"}${this.stderrTail.length ? `: ${this.stderrTail.toString("utf-8")}` : ""}`));
      this.onClose();
    });
    this.setReferenced(child, false);
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_FRAME_BYTES) {
      this.stop("cadctl worker response exceeded its frame limit");
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(10);
      if (newline < 0) return;
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf-8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let frame: WorkerFrame;
      try { frame = JSON.parse(line) as WorkerFrame; }
      catch {
        this.stop(`cadctl worker returned invalid JSON: ${line.slice(0, 200)}`);
        return;
      }
      const pending = this.pending;
      if (!pending || frame.id !== pending.id) {
        this.stop(`cadctl worker returned unexpected response id ${String(frame.id)}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending = null;
      workerStats.requests += 1;
      pending.resolve({ exitCode: frame.exitCode, stdout: frame.stdout, stderr: frame.stderr });
    }
  }

  private fail(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const reject = this.pending.reject;
    this.pending = null;
    reject(error);
  }

  private setReferenced(child: InteractiveProcess, referenced: boolean): void {
    const method = referenced ? "ref" : "unref";
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as Record<string, (() => void) | undefined>)[method]?.();
    }
  }
}

const workers = new Map<string, WarmCadctlWorker>();
const workerStats = { starts: 0, requests: 0 };

process.once("exit", () => {
  for (const worker of [...workers.values()]) worker.stop("parent process exited");
});

export async function runWarmCadctl(
  launch: WarmCadctlLaunch,
  request: WarmCadctlRequest,
): Promise<WarmCadctlResult> {
  let worker = workers.get(launch.key);
  if (!worker) {
    worker = new WarmCadctlWorker(launch, () => {
      if (workers.get(launch.key) === worker) workers.delete(launch.key);
    });
    workers.set(launch.key, worker);
  }
  return worker.run(request);
}

export function warmCadctlWorkerStats(): { starts: number; requests: number } {
  return { ...workerStats };
}

export function shutdownWarmCadctlWorkers(): void {
  for (const worker of [...workers.values()]) worker.stop();
  workers.clear();
}
