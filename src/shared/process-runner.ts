import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { assertLinuxRuntime } from "./platform.ts";

export interface ProcessPoll {
  intervalMs: number;
  check(): Promise<string | null>;
}

export interface RunProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  poll?: ProcessPoll;
  gate?: ProcessConcurrencyGate;
}

export interface ProcessResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  terminationReason?: "timeout" | "aborted" | "poll";
  terminationDetail?: string;
}

interface GateWaiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Bounded process admission shared by every runtime subprocess. */
export class ProcessConcurrencyGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];
  private peak = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("process concurrency limit must be a positive integer");
  }

  get snapshot(): { active: number; queued: number; peak: number; limit: number } {
    return { active: this.active, queued: this.waiters.length, peak: this.peak, limit: this.limit };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("process aborted before admission");
    if (this.active < this.limit) return this.admit();
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: GateWaiter = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("process aborted before admission"));
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private admit(): () => void {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (!next) return;
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.resolve(this.admit());
    };
  }
}

function configuredProcessLimit(): number {
  const parsed = Number(process.env.PI_CAD_MAX_PROCESSES ?? "4");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}

export const processConcurrencyGate = new ProcessConcurrencyGate(configuredProcessLimit());

class TailCapture {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.limit === 0) return;
    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.length;
    while (this.bytes > this.limit && this.chunks.length > 0) {
      const excess = this.bytes - this.limit;
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function endStream(stream: WriteStream | null): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => stream.end(resolve));
}

export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  assertLinuxRuntime("Pi-CAD process runner");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("process timeoutMs must be positive");
  if (options.signal?.aborted) throw new Error("process aborted before spawn");
  const maxStdout = options.maxStdoutBytes ?? 1024 * 1024;
  const maxStderr = options.maxStderrBytes ?? 1024 * 1024;
  if (maxStdout < 0 || maxStderr < 0) throw new Error("process output limits cannot be negative");
  if (options.stdoutPath) await mkdir(dirname(options.stdoutPath), { recursive: true });
  if (options.stderrPath) await mkdir(dirname(options.stderrPath), { recursive: true });

  const release = await (options.gate ?? processConcurrencyGate).acquire(options.signal);

  try {

    const stdoutFile = options.stdoutPath ? createWriteStream(options.stdoutPath) : null;
    const stderrFile = options.stderrPath ? createWriteStream(options.stderrPath) : null;
    const stdout = new TailCapture(maxStdout);
    const stderr = new TailCapture(maxStderr);
    const started = Date.now();

    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let terminationReason: ProcessResult["terminationReason"];
    let terminationDetail: string | undefined;
    let pollRunning = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: NonNullable<ProcessResult["terminationReason"]>, detail: string) => {
      if (terminationReason) return;
      terminationReason = reason;
      terminationDetail = detail;
      terminateProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 250);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => terminate("timeout", `timeout after ${options.timeoutMs}ms`), options.timeoutMs);
    timeout.unref();
    const abort = () => terminate("aborted", "aborted by signal");
    options.signal?.addEventListener("abort", abort, { once: true });
    const pollTimer = options.poll
      ? setInterval(async () => {
          if (pollRunning || settled) return;
          pollRunning = true;
          try {
            const detail = await options.poll!.check();
            if (detail) terminate("poll", detail);
          } catch {
            // A transient poll failure is retried at the next bounded interval.
          } finally {
            pollRunning = false;
          }
        }, options.poll.intervalMs)
      : undefined;
    pollTimer?.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutFile?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      stderrFile?.write(chunk);
    });
    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (pollTimer) clearInterval(pollTimer);
      options.signal?.removeEventListener("abort", abort);
      await Promise.all([endStream(stdoutFile), endStream(stderrFile)]);
      reject(error);
    });
      child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (pollTimer) clearInterval(pollTimer);
      options.signal?.removeEventListener("abort", abort);
      await Promise.all([endStream(stdoutFile), endStream(stderrFile)]);
      resolve({
        exitCode: code ?? (terminationReason ? 1 : 127),
        signal,
        durationMs: Date.now() - started,
        stdout: stdout.text(),
        stderr: stderr.text(),
        ...(terminationReason ? { terminationReason, terminationDetail } : {}),
      });
      });
    });
  } finally {
    release();
  }
}

const PROBE_WORKER_PROTOCOL = "pi-cad/probe-worker-v1";

interface ProbeWorkerResponse {
  protocol: typeof PROBE_WORKER_PROTOCOL;
  id: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  workerPid?: number;
  error?: string;
}

interface ProbeWorkerPending {
  resolve(value: ProbeWorkerResponse): void;
  reject(error: Error): void;
}

export interface ProbeWorkerOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  idleMs?: number;
  maxRequests?: number;
}

export class ProbeWorkerRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeWorkerRejectedError";
  }
}

/** One sequential Python interpreter inside the repository's process boundary. */
export class PersistentProbeWorker {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadLineInterface;
  private pending = new Map<string, ProbeWorkerPending>();
  private queue: Promise<void> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private requests = 0;
  private stderr = "";

  constructor(private readonly options: ProbeWorkerOptions) {}

  get snapshot(): { running: boolean; pid?: number; requests: number; queued: boolean } {
    return { running: Boolean(this.child && this.child.exitCode === null && !this.child.killed), ...(this.child?.pid ? { pid: this.child.pid } : {}), requests: this.requests, queued: this.pending.size > 0 };
  }

  request(input: { cwd: string; args: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
    const scheduled = this.queue.then(() => this.execute(input));
    this.queue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const child = this.child;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
    }
    const error = new Error("probe worker stopped");
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.requests = 0;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    assertLinuxRuntime("Pi-CAD persistent probe worker");
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    const child = spawn(this.options.command, this.options.args, { env: this.options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.unref();
    (child.stdin as any).unref?.();
    (child.stdout as any).unref?.();
    (child.stderr as any).unref?.();
    this.child = child;
    this.stderr = "";
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf-8")}`.slice(-256 * 1024); });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => this.fail(new Error(`probe worker exited (${code ?? signal ?? "unknown"}): ${this.stderr.slice(-8192)}`)));
    return child;
  }

  private onLine(line: string): void {
    if (Buffer.byteLength(line) > 20 * 1024 * 1024) {
      this.fail(new Error("probe worker response exceeds 20 MiB protocol limit"));
      return;
    }
    let response: ProbeWorkerResponse;
    try { response = JSON.parse(line) as ProbeWorkerResponse; }
    catch { this.fail(new Error(`probe worker emitted non-JSON protocol output: ${line.slice(0, 512)}`)); return; }
    if (response.protocol !== PROBE_WORKER_PROTOCOL || typeof response.id !== "string") {
      this.fail(new Error("probe worker protocol mismatch"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private fail(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    for (const item of pending) item.reject(error);
  }

  private async execute(input: { cwd: string; args: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
    if (input.signal?.aborted) throw new Error("probe worker request aborted before dispatch");
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("probe worker timeoutMs must be positive");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.ensureStarted();
    const id = randomUUID();
    const started = Date.now();
    const response = await new Promise<ProbeWorkerResponse>((resolve, reject) => {
      const terminate = (reason: string) => {
        if (!this.pending.delete(id)) return;
        this.stop();
        reject(new Error(reason));
      };
      const timeout = setTimeout(() => terminate(`probe worker timeout after ${input.timeoutMs}ms`), input.timeoutMs);
      const abort = () => terminate("probe worker request aborted");
      input.signal?.addEventListener("abort", abort, { once: true });
      const clear = () => { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve(value) { clear(); resolve(value); }, reject(error) { clear(); reject(error); } });
      child.stdin.write(`${JSON.stringify({ protocol: PROBE_WORKER_PROTOCOL, id, cwd: input.cwd, args: input.args })}\n`, (error) => { if (error) terminate(`probe worker write failed: ${error.message}`); });
    });
    if (!response.ok) throw new ProbeWorkerRejectedError(response.error ?? "probe worker rejected request");
    this.requests += 1;
    if (this.requests >= (this.options.maxRequests ?? 500)) this.stop();
    else {
      this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs ?? 10 * 60_000);
      this.idleTimer.unref();
    }
    return { exitCode: response.exitCode ?? 1, signal: null, durationMs: Date.now() - started, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  }
}
