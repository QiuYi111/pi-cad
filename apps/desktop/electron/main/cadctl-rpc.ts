import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { RuntimeBridge } from "./runtime-bridge.js";

interface WorkerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WorkerFrame extends WorkerResult {
  id: number;
  workerPid: number;
  childPid?: number;
}

interface Pending {
  id: number;
  timer: NodeJS.Timeout;
  resolve(value: WorkerResult): void;
  reject(error: Error): void;
}

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class DesktopCadctlRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private python = "";
  private buffer = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private pending: Pending | null = null;
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bridge: RuntimeBridge) {}

  run(python: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<WorkerResult> {
    const task = this.queue.then(
      () => this.runOne(python, args, cwd, timeoutMs),
      () => this.runOne(python, args, cwd, timeoutMs),
    );
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  stop(reason = "cadctl preview worker stopped"): void {
    const child = this.child;
    this.child = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
    child?.kill("SIGTERM");
  }

  private runOne(python: string, args: string[], cwd: string, timeoutMs: number): Promise<WorkerResult> {
    const child = this.ensureChild(python);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        reject(new Error(`cadctl preview timed out after ${timeoutMs}ms`));
        this.stop("cadctl preview timed out");
      }, timeoutMs);
      timer.unref();
      this.pending = { id, timer, resolve, reject };
      child.stdin.write(`${JSON.stringify({ id, args, cwd, timeoutMs })}\n`, "utf8", (error) => {
        if (!error || this.pending?.id !== id) return;
        clearTimeout(timer);
        this.pending = null;
        reject(error);
        this.stop("cadctl preview input failed");
      });
    });
  }

  private ensureChild(python: string): ChildProcessWithoutNullStreams {
    if (this.child && this.python === python && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    this.stop();
    this.python = python;
    this.buffer = Buffer.alloc(0);
    this.stderrTail = Buffer.alloc(0);
    const child = this.bridge.spawn([python, "-m", "cadctl.worker"]);
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-8192);
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(new Error(`cadctl preview worker exited with ${code ?? signal ?? "unknown status"}${this.stderrTail.length ? `: ${this.stderrTail.toString("utf8")}` : ""}`));
    });
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.stop("cadctl preview response exceeded its limit");
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let frame: WorkerFrame;
      try {
        frame = JSON.parse(line) as WorkerFrame;
      } catch {
        this.stop(`cadctl preview returned invalid JSON: ${line.slice(0, 160)}`);
        return;
      }
      const pending = this.pending;
      if (!pending || pending.id !== frame.id) {
        this.stop(`cadctl preview returned unexpected response ${String(frame.id)}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending = null;
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
}
