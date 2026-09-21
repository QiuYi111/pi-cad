import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

import { isProcessAlive, LAUNCHER, REPO_ROOT } from "../sut/proc.ts";

const READY_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 180_000;

export interface ReifyRuntimeRequest {
  at: number;
  op: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface ReifyRuntimeInfo {
  pid: number;
  authorSocket: string;
  reviewerSocket: string;
  startedAt: number;
  /** How many times this adapter has restarted the real runtime process. */
  restarts: number;
}

export interface ReifyRuntimeOptions {
  /** Real Reify project the runtime owns. */
  project: string;
  /** Where the runtime keeps its sockets (inside the project's temp root). */
  runtimeDirectory: string;
  /** Environment the runtime process inherits (project + canonical + workflow home). */
  env: NodeJS.ProcessEnv;
}

/** One real JSON request to the authority socket; the server ends the socket with the reply. */
function socketRequest<T>(socketPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Reify runtime socket timed out")));
    socket.on("connect", () => socket.end(JSON.stringify({ schema: 1, ...payload })));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        finish(() => reject(new Error("Reify runtime closed without a response")));
        return;
      }
      let response: { ok?: boolean; result?: unknown; error?: { message?: string } };
      try {
        response = JSON.parse(text) as typeof response;
      } catch (error) {
        finish(() => reject(error as Error));
        return;
      }
      if (!response.ok) finish(() => reject(new Error(response.error?.message ?? "Reify runtime rejected the request")));
      else finish(() => accept(response.result as T));
    });
  });
}

/**
 * The real Reify runtime under chaos: a long-lived authority sidecar process.
 *
 * Every call goes over the real Unix socket the Desktop uses, so a request is
 * served by the same code path the product runs, and the runtime itself has a
 * real lifecycle (start / stop / restart) with a real pid.
 */
export class ReifyRuntime {
  readonly requests: ReifyRuntimeRequest[] = [];
  /** Wall-clock times the runtime was restarted, for the artifact timeline. */
  readonly restarts: number[] = [];
  private child?: ChildProcess;
  private info?: ReifyRuntimeInfo;
  private log = "";

  private constructor(private readonly options: ReifyRuntimeOptions) {}

  static async start(options: ReifyRuntimeOptions): Promise<ReifyRuntime> {
    const runtime = new ReifyRuntime(options);
    await runtime.start();
    return runtime;
  }

  get pid(): number {
    return this.info?.pid ?? 0;
  }

  get authorSocket(): string {
    return this.info?.authorSocket ?? "";
  }

  get reviewerSocket(): string {
    return this.info?.reviewerSocket ?? "";
  }

  get alive(): boolean {
    return this.pid > 0 && isProcessAlive(this.pid);
  }

  get current(): ReifyRuntimeInfo | undefined {
    return this.info;
  }

  /** Real stderr/stdout tail of the runtime process, for the artifact. */
  get logTail(): string {
    return this.log.slice(-4096);
  }

  async start(): Promise<ReifyRuntimeInfo> {
    if (this.child && this.alive) return this.info!;
    const child = spawn(
      process.execPath,
      [LAUNCHER, "__reify-runtime", this.options.project, this.options.runtimeDirectory],
      { cwd: REPO_ROOT, env: this.options.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      this.log = `${this.log}${chunk.toString("utf8")}`;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.log = `${this.log}${chunk.toString("utf8")}`;
    });
    const ready = await new Promise<{ pid: number; authorSocket: string; reviewerSocket: string }>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Reify runtime did not report ready within its budget")), READY_TIMEOUT_MS);
      const inspect = () => {
        for (const line of stdout.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const parsed = JSON.parse(line) as { ok?: boolean; pid?: number; authorSocket?: string; reviewerSocket?: string };
            if (parsed.ok && parsed.pid && parsed.authorSocket) {
              clearTimeout(timer);
              accept({ pid: parsed.pid, authorSocket: parsed.authorSocket, reviewerSocket: parsed.reviewerSocket ?? "" });
              return;
            }
          } catch {
            /* not the ready line */
          }
        }
      };
      child.stdout?.on("data", inspect);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Reify runtime exited before ready (${signal ?? code}): ${this.log.slice(-300)}`));
      });
      inspect();
    });
    this.info = { ...ready, startedAt: Date.now(), restarts: this.restarts.length };
    return this.info;
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.info = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((accept) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        accept();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        accept();
      });
      child.kill(signal);
    });
  }

  /** Stop the runtime process and start a fresh one; the pid really changes. */
  async restart(): Promise<ReifyRuntimeInfo> {
    await this.stop();
    const info = await this.start();
    this.restarts.push(info.startedAt);
    this.info = { ...info, restarts: this.restarts.length };
    return this.info;
  }

  /** One real request through the runtime's own socket. */
  async call(op: string, extra: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.info) throw new Error("Reify runtime is not running");
    const startedAt = Date.now();
    try {
      const result = await socketRequest<unknown>(this.info.authorSocket, { op, ...extra }, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      this.requests.push({ at: startedAt, op, ok: true, ms: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.requests.push({ at: startedAt, op, ok: false, ms: Date.now() - startedAt, error: (error as Error).message });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
