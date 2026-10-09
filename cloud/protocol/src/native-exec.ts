import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export type ExecCollectOptions = {
  input?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxBytes?: number;
};

export class ExecExitError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = "ExecExitError";
  }
}

// Shared by NativeBridge (desktop) and the workspace gateway. A non-zero exit
// rejects with an ExecExitError carrying the captured stdout/stderr, code and signal.
export async function execCollect(args: string[], options: ExecCollectOptions = {}) {
  const [command, ...rest] = args;
  if (!command) throw new Error("Runtime command is empty.");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(command, rest, { stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env, cwd: options.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolveResult(result!);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error(`${command} output exceeded ${formatMiB(maxBytes)} MiB`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) finish(undefined, result);
      else finish(new ExecExitError(`${command} exited with ${code ?? signal ?? "unknown status"}${result.stderr ? `: ${result.stderr}` : ""}`, result.stdout, result.stderr, code, signal));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);
    timer.unref();
    child.stdin.on("error", () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function formatMiB(bytes: number): string {
  return String(bytes / (1024 * 1024));
}
