import { NdjsonWorker, NdjsonWorkerRegistry, type NdjsonLaunch, type NdjsonProtocol } from "./ndjson-worker.ts";

const HOT_COMMANDS = new Set([
  "assembly-tree",
  "bind-identity",
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

interface WireRequest {
  args: string[];
  cwd: string;
  timeoutMs: number;
}

const PROTOCOL: NdjsonProtocol<WireRequest, WarmCadctlResult> = {
  name: "cadctl",
  wireId: (n) => n,
  encode: (id, request) => ({ id, args: request.args, cwd: request.cwd, timeoutMs: request.timeoutMs }),
  decode: (frame) => {
    const { exitCode, stdout, stderr } = frame as WarmCadctlResult;
    return { ok: true, value: { exitCode, stdout, stderr } };
  },
  restartError: (message, stderrTail) => new Error(stderrTail ? `${message}: ${stderrTail}` : message),
  killSignal: "SIGTERM",
  stderrTailBytes: 8192,
};

export function isWarmCadctlCommand(command: string | undefined): boolean {
  return !!command && HOT_COMMANDS.has(command);
}

class WarmCadctlWorker {
  private readonly io: NdjsonWorker<WireRequest, WarmCadctlResult>;

  constructor(private readonly launch: WarmCadctlLaunch, onGone: () => void) {
    this.io = new NdjsonWorker(PROTOCOL, onGone);
  }

  run(request: WarmCadctlRequest): Promise<WarmCadctlResult> {
    return this.io.serial(() => this.runOne(request));
  }

  stop(reason?: string): void {
    this.io.stop(reason);
  }

  private async runOne(request: WarmCadctlRequest): Promise<WarmCadctlResult> {
    const launch = (): NdjsonLaunch => this.launch;
    return this.io.withChild(launch, async (child) => {
      const result = await this.io.exchange(
        child,
        { args: request.args, cwd: request.cwd, timeoutMs: request.timeoutMs },
        { timeoutMs: request.timeoutMs, timeoutError: () => new Error(`cadctl worker timed out after ${request.timeoutMs}ms`) },
      );
      if (Buffer.byteLength(result.stdout) > request.maxStdoutBytes) throw new Error("cadctl worker stdout exceeded its limit");
      if (Buffer.byteLength(result.stderr) > request.maxStderrBytes) throw new Error("cadctl worker stderr exceeded its limit");
      return result;
    });
  }
}

const workers = new NdjsonWorkerRegistry<WarmCadctlWorker>();

export async function runWarmCadctl(
  launch: WarmCadctlLaunch,
  request: WarmCadctlRequest,
): Promise<WarmCadctlResult> {
  const worker = workers.get(launch.key, () => new WarmCadctlWorker(launch, () => workers.forget(launch.key, worker)));
  return worker.run(request);
}

export function shutdownWarmCadctlWorkers(): void {
  workers.stopAll();
}
