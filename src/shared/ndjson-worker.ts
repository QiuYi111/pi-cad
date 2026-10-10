/**
 * One long-lived child process spoken to over NDJSON on stdio.
 *
 * The base owns everything the workers used to duplicate: spawning, line
 * framing with a frame-size cap, request id matching, the per-request timeout
 * and abort, restart after exit or failure, stderr tail capture, the
 * ref/unref dance that keeps an idle worker from holding the event loop, and
 * an optional idle exit. A worker supplies only its wire protocol and the
 * error class it reports with.
 *
 * Requests run one at a time per instance (`serial`), in order. A request that
 * fails for any reason other than a worker-level error leaves the child alive;
 * a timeout, abort, framing error or exit stops it and the next request starts
 * a fresh child.
 */
import { kernelOwnerBinding } from "./kernel-owner.ts";
import { processConcurrencyGate, spawnInteractiveProcess } from "./process-runner.ts";

/** The child process a worker talks to over its stdio pipes. */
export type NdjsonChild = ReturnType<typeof spawnInteractiveProcess>;

export const NDJSON_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface NdjsonLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type NdjsonOutcome<Res> = { ok: true; value: Res } | { ok: false; error: Error };

export interface NdjsonProtocol<Req, Res> {
  /** Prefix for messages the base writes, e.g. "cadctl". */
  name: string;
  /** Wire id for the n-th request sent to one child (n counts from 1). */
  wireId(n: number): number | string;
  /** The JSON object written for one request; the base adds the newline. */
  encode(wireId: number | string, request: Req): object;
  /** Reads one parsed response frame. `stderrTail` is the child's recent stderr. */
  decode(frame: unknown, stderrTail: string): NdjsonOutcome<Res>;
  /** Error for a request that was pending when the child was stopped, exited or broke framing. */
  restartError(message: string, stderrTail: string): Error;
  /** Signal for stopping a child (sent to its process group). */
  killSignal: NodeJS.Signals;
  /** Bytes of stderr kept for diagnostics. */
  stderrTailBytes: number;
  /** Stop the child after this many idle milliseconds with no request in flight. Unset: never. */
  idleMs?: number;
  /** Error when the concurrency gate refuses a request because its signal aborted first. */
  admissionError?(): Error;
  /** Error when a request is aborted while in flight. The child is stopped either way. */
  abortError?(): Error;
}

export interface ExchangeOptions<Res> {
  timeoutMs: number;
  timeoutError(): Error;
  signal?: AbortSignal;
}

interface Pending<Res> {
  id: number | string;
  timer: NodeJS.Timeout;
  resolve(value: Res): void;
  reject(error: Error): void;
}

export class NdjsonWorker<Req, Res> {
  private child: NdjsonChild | null = null;
  private pending: Pending<Res> | null = null;
  private buffer = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private counter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  /**
   * @param onChildGone runs whenever the child is stopped or exits, after its
   *   in-flight request has been settled. Use it to drop per-child state.
   */
  constructor(
    private readonly protocol: NdjsonProtocol<Req, Res>,
    private readonly onChildGone: () => void = () => {},
  ) {}

  /** Run `task` after every earlier task on this worker has settled. */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = () => task();
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Admit one request through the process gate, start the child if needed,
   * and run `use` with it. The child is unref'd again when `use` settles so an
   * idle worker never keeps the process alive.
   */
  async withChild<T>(
    launch: () => NdjsonLaunch,
    use: (child: NdjsonChild) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await processConcurrencyGate.acquire(signal).catch((error: unknown) => {
      throw this.protocol.admissionError?.() ?? error;
    });
    try {
      const child = this.ensureChild(launch);
      this.setReferenced(child, true);
      return await use(child);
    } finally {
      if (this.child) this.setReferenced(this.child, false);
      release();
      this.armIdle();
    }
  }

  /**
   * Send one request on `child` and resolve with its matching response. A
   * timeout or abort stops the child; so does a response with an unexpected id.
   */
  exchange(child: NdjsonChild, request: Req, options: ExchangeOptions<Res>): Promise<Res> {
    const wireId = this.protocol.wireId(++this.counter);
    return new Promise<Res>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const finish = (action: () => void) => {
        if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
        action();
      };
      const timer = setTimeout(() => {
        this.pending = null;
        finish(() => reject(options.timeoutError()));
        this.stop(`${this.protocol.name} worker stopped after a timeout`);
      }, options.timeoutMs);
      timer.unref();
      onAbort = () => {
        clearTimeout(timer);
        this.pending = null;
        finish(() => reject(this.protocol.abortError?.() ?? new Error("request aborted")));
        this.stop(`${this.protocol.name} worker stopped after cancellation`);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id: wireId,
        timer,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      };
      const line = `${JSON.stringify(this.protocol.encode(wireId, request))}\n`;
      child.stdin.write(line, "utf8", (error) => {
        if (!error || this.pending?.id !== wireId) return;
        clearTimeout(timer);
        this.pending = null;
        finish(() => reject(error));
        this.stop(`${this.protocol.name} worker input failed`);
      });
    });
  }

  /** Kill the child, if any, and reject its pending request. The next request starts a new child. */
  stop(reason?: string): void {
    const child = this.child;
    this.child = null;
    this.clearIdle();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const { reject } = this.pending;
      this.pending = null;
      reject(this.protocol.restartError(reason ?? `${this.protocol.name} worker stopped`, this.stderrText()));
    }
    if (child?.pid) {
      try { process.kill(-child.pid, this.protocol.killSignal); }
      catch { child.kill(this.protocol.killSignal); }
    }
    this.onChildGone();
  }

  stderrText(): string {
    return this.stderrTail.toString("utf8");
  }

  private ensureChild(launch: () => NdjsonLaunch): NdjsonChild {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const spec = launch();
    const child = spawnInteractiveProcess({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: { ...spec.env, ...kernelOwnerBinding() },
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.stderrTail = Buffer.alloc(0);
    const tailBytes = this.protocol.stderrTailBytes;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-tailBytes);
    });
    child.on("error", (error) => this.fail(this.protocol.restartError(`${this.protocol.name} worker failed to start: ${error.message}`, this.stderrText())));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearIdle();
      this.fail(this.protocol.restartError(`${this.protocol.name} worker exited with ${code ?? signal ?? "unknown status"}`, this.stderrText()));
      this.onChildGone();
    });
    this.setReferenced(child, false);
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > NDJSON_MAX_FRAME_BYTES) {
      this.stop(`${this.protocol.name} worker response exceeded its frame limit`);
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const text = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!text.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(text); }
      catch {
        this.stop(`${this.protocol.name} worker returned invalid JSON: ${text.slice(0, 200)}`);
        return;
      }
      const id = (frame as { id?: unknown } | null)?.id;
      const pending = this.pending;
      if (!pending || id !== pending.id) {
        this.stop(`${this.protocol.name} worker returned unexpected response id ${String(id)}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending = null;
      const outcome = this.protocol.decode(frame, this.stderrText());
      if (outcome.ok) pending.resolve(outcome.value);
      else pending.reject(outcome.error);
    }
  }

  private fail(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { reject } = this.pending;
    this.pending = null;
    reject(error);
  }

  private armIdle(): void {
    const idleMs = this.protocol.idleMs;
    if (idleMs === undefined) return;
    this.clearIdle();
    this.idle = setTimeout(() => this.stop(`${this.protocol.name} worker idle`), idleMs);
    this.idle.unref();
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private setReferenced(child: NdjsonChild, referenced: boolean): void {
    const method = referenced ? "ref" : "unref";
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as Record<string, (() => void) | undefined>)[method]?.();
    }
  }
}

/** Workers keyed by project or command, stopped together when the process exits. */
export class NdjsonWorkerRegistry<W extends { stop(reason?: string): void }> {
  private readonly workers = new Map<string, W>();

  constructor() {
    process.once("exit", () => this.stopAll("parent process exited"));
  }

  get(key: string, create: () => W): W {
    let worker = this.workers.get(key);
    if (!worker) {
      worker = create();
      this.workers.set(key, worker);
    }
    return worker;
  }

  /** Drop `worker` from the map if it is still the entry for `key`. */
  forget(key: string, worker: W): void {
    if (this.workers.get(key) === worker) this.workers.delete(key);
  }

  stopAll(reason?: string): void {
    for (const worker of [...this.workers.values()]) worker.stop(reason);
    this.workers.clear();
  }
}
