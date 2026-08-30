import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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

export interface DetachedProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Start a deliberately detached supervisor without leaking child_process imports across the runtime. */
export function spawnDetachedProcess(options: DetachedProcessOptions): void {
  assertLinuxRuntime("Pi-CAD detached process runner");
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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
