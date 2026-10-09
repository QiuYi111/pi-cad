/**
 * Bridge to the FreeCAD part worker (`python/reify_freecad`).
 *
 * One long-lived worker per project directory speaks NDJSON over stdio and
 * keeps the open documents in memory. FreeCAD is not thread safe, so every
 * request to one worker runs in order. The worker runs in the optional FreeCAD
 * conda environment (`npm run setup:freecad`), never in the uv environment.
 *
 * A request that outlives its budget, or an aborted request, kills the worker;
 * the next request starts a fresh one and reopens the documents from disk. Disk
 * only ever holds the last committed revision, so a killed transaction is lost,
 * which is the correct outcome.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { packageRoot } from "./capability.ts";
import { kernelOwnerBinding } from "./kernel-owner.ts";
import { processConcurrencyGate, spawnInteractiveProcess } from "./process-runner.ts";

type InteractiveProcess = ReturnType<typeof spawnInteractiveProcess>;

export const IDLE_EXIT_MS = 10 * 60_000;
export const DEFAULT_BUDGET_S = 30;
export const DEFAULT_MAX_BUDGET_S = 600;
/** Seconds a worker may run past its budget before it is killed (tests shorten it). */
function killGraceSeconds(): number {
  const parsed = Number(process.env.PI_CAD_PART_KILL_GRACE_S ?? 5);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
}
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;

export interface PartErrorFields {
  code: string;
  target?: string;
  detail?: Record<string, unknown>;
  hints?: string[];
  rolledBack?: boolean;
}

export class PartOpError extends Error {
  readonly code: string;
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
  readonly hints?: string[];
  readonly rolledBack?: boolean;

  constructor(message: string, fields: PartErrorFields) {
    super(message);
    this.name = "PartOpError";
    this.code = fields.code;
    if (fields.target !== undefined) this.target = fields.target;
    if (fields.detail !== undefined) this.detail = fields.detail;
    if (fields.hints !== undefined) this.hints = fields.hints;
    if (fields.rolledBack !== undefined) this.rolledBack = fields.rolledBack;
  }
}

export interface FreecadRuntime {
  python: string;
  /** Directory holding FreeCAD.so; not on sys.path by default. */
  libPath: string;
}

function runtimeJsonPath(): string {
  const configured = process.env.PI_CAD_FREECAD_HOME;
  if (configured) return join(configured, "runtime.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "pi-cad", "runtimes", "freecad", "runtime.json");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-cad", "runtimes", "freecad", "runtime.json");
}

/** `PI_CAD_FREECAD_PYTHON`, then runtime.json. Never downloads anything. */
export function resolveFreecadRuntime(): FreecadRuntime {
  const searched: string[] = [];
  const override = (process.env.PI_CAD_FREECAD_PYTHON ?? "").trim();
  if (override) {
    searched.push(`PI_CAD_FREECAD_PYTHON=${override}`);
    if (existsSync(override)) {
      return { python: override, libPath: process.env.PI_CAD_FREECAD_LIB?.trim() || join(dirname(dirname(override)), "lib") };
    }
  }
  const manifest = runtimeJsonPath();
  searched.push(manifest);
  if (existsSync(manifest)) {
    try {
      const record = JSON.parse(readFileSync(manifest, "utf8")) as { python?: string; libPath?: string };
      if (record.python && existsSync(record.python)) {
        return { python: record.python, libPath: record.libPath ?? join(dirname(dirname(record.python)), "lib") };
      }
      searched.push(String(record.python));
    } catch { /* fall through to the not-installed error */ }
  }
  throw new PartOpError("FreeCAD is not installed for Pi-CAD", {
    code: "FREECAD_NOT_INSTALLED",
    detail: { searched, size: "about 4.2 GB", sudo: false, note: "Tell the user this one command and stop. Do not fall back to build123d." },
    hints: ["run: npm run setup:freecad"],
  });
}

export function maxBudgetSeconds(): number {
  const parsed = Number(process.env.PI_CAD_PART_MAX_BUDGET_S ?? DEFAULT_MAX_BUDGET_S);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BUDGET_S;
}

export interface PartRequest {
  op: string;
  /** Absolute path of the `.FCStd` document. */
  doc: string;
  args?: Record<string, unknown>;
  budgetS?: number;
  signal?: AbortSignal;
  /**
   * How to open `doc` when this bridge has not opened it. The sidecar can restart
   * (desktop restart, session resume) while documents stay on disk, so every
   * request names the arguments an open needs; an existing file is then opened
   * on first use and the caller never sees DOCUMENT_NOT_OPEN.
   */
  ensureOpen?: Record<string, unknown>;
}

interface Frame {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; target?: string; detail?: Record<string, unknown>; hints?: string[]; rolledBack?: boolean };
}

interface Pending {
  id: string;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class PartWorker {
  private child: InteractiveProcess | null = null;
  private pending: Pending | null = null;
  private buffer = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private counter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  /** Documents the live child has open. */
  private openInChild = new Set<string>();
  /** How each document was last opened, to reopen it after a restart. */
  private readonly openArgs = new Map<string, Record<string, unknown>>();

  constructor(private readonly cwd: string, private readonly onClose: () => void) {}

  run(request: PartRequest): Promise<unknown> {
    const task = this.queue.then(() => this.runOne(request), () => this.runOne(request));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  stop(reason = "FreeCAD worker stopped"): void {
    const child = this.child;
    this.child = null;
    this.openInChild.clear();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new PartOpError(reason, { code: "FREECAD_WORKER_RESTARTED", hints: ["retry"], detail: { stderrTail: this.stderrText() } }));
      this.pending = null;
    }
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }
    this.onClose();
  }

  private stderrText(): string {
    return this.stderrTail.toString("utf8");
  }

  private async runOne(request: PartRequest): Promise<unknown> {
    const runtime = resolveFreecadRuntime();
    const limit = maxBudgetSeconds();
    const budgetS = request.budgetS ?? DEFAULT_BUDGET_S;
    if (budgetS > limit) {
      throw new PartOpError(`budget ${budgetS}s exceeds the limit of ${limit}s`, {
        code: "BUDGET_EXCEEDS_LIMIT",
        detail: { budgetS, limitS: limit },
        hints: ["increase budget_s up to the limit", "split the check"],
      });
    }
    if (request.signal?.aborted) throw new PartOpError("request cancelled", { code: "CANCELLED" });
    const release = await processConcurrencyGate.acquire(request.signal).catch(() => {
      throw new PartOpError("request cancelled", { code: "CANCELLED" });
    });
    try {
      if (request.op === "open") this.openArgs.set(request.doc, { ...(request.args ?? {}), export: true });
      const child = this.ensureChild(runtime);
      this.setReferenced(child, true);
      if (request.op !== "open" && !this.openInChild.has(request.doc)) {
        let reopen = this.openArgs.get(request.doc);
        if (!reopen && request.ensureOpen && existsSync(request.doc)) {
          reopen = { ...request.ensureOpen, export: true };
          this.openArgs.set(request.doc, reopen);
        }
        if (reopen) await this.send(child, { op: "open", doc: request.doc, args: { ...reopen, create: false, export: false }, budgetS }, budgetS, request.signal);
      }
      const result = await this.send(child, request, budgetS, request.signal);
      assertSameDocument(request, result);
      if (request.op === "open") this.openInChild.add(request.doc);
      if (request.op === "close") { this.openInChild.delete(request.doc); this.openArgs.delete(request.doc); }
      return result;
    } finally {
      if (this.child) this.setReferenced(this.child, false);
      release();
      this.armIdle();
    }
  }

  private send(child: InteractiveProcess, request: PartRequest, budgetS: number, signal?: AbortSignal): Promise<unknown> {
    const id = `r-${++this.counter}`;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      let onAbort: (() => void) | undefined;
      const finish = (action: () => void) => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        action();
      };
      const timer = setTimeout(() => {
        const detail = { budgetS, stderrTail: this.stderrText() };
        this.pending = null;
        finish(() => rejectRequest(new PartOpError(`${request.op} exceeded its budget of ${budgetS}s and was stopped`, {
          code: "BUDGET_EXCEEDED", detail, hints: ["increase budget_s", "split the check", "the worker was restarted; the document is at its last committed revision, so undo is not needed"],
        })));
        this.stop("FreeCAD worker stopped after a budget overrun");
      }, (budgetS + killGraceSeconds()) * 1000);
      timer.unref();
      onAbort = () => {
        clearTimeout(timer);
        this.pending = null;
        finish(() => rejectRequest(new PartOpError("request cancelled", { code: "CANCELLED", rolledBack: true })));
        this.stop("FreeCAD worker stopped after cancellation");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id,
        timer,
        resolve: (value) => finish(() => resolveRequest(value)),
        reject: (error) => finish(() => rejectRequest(error)),
      };
      const line = `${JSON.stringify({ id, op: request.op, doc: request.doc, args: request.args ?? {}, budgetS })}\n`;
      child.stdin.write(line, "utf8", (error) => {
        if (!error || this.pending?.id !== id) return;
        clearTimeout(timer);
        this.pending = null;
        finish(() => rejectRequest(error));
        this.stop("FreeCAD worker input failed");
      });
    });
  }

  private ensureChild(runtime: FreecadRuntime): InteractiveProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const env: NodeJS.ProcessEnv = { ...process.env, ...kernelOwnerBinding(), NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    // The worker has its own interpreter; the uv environment's search path
    // would shadow FreeCAD's modules.
    delete env.PYTHONHOME;
    delete env.VIRTUAL_ENV;
    env.PYTHONPATH = [join(packageRoot(), "python"), runtime.libPath].join(":");
    env.PYTHONNOUSERSITE = "1";
    env.PYTHONDONTWRITEBYTECODE = "1";
    env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM ?? "offscreen";
    const child = spawnInteractiveProcess({
      command: runtime.python,
      args: ["-m", "reify_freecad.worker"],
      cwd: resolve(this.cwd),
      env,
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.stderrTail = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => this.fail(new PartOpError(`FreeCAD worker failed to start: ${error.message}`, { code: "FREECAD_WORKER_RESTARTED", hints: ["retry"] })));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.openInChild.clear();
      this.fail(new PartOpError(`FreeCAD worker exited with ${code ?? signal ?? "unknown status"}`, {
        code: "FREECAD_WORKER_RESTARTED", hints: ["retry"], detail: { stderrTail: this.stderrText() },
      }));
      this.onClose();
    });
    this.setReferenced(child, false);
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.stop("FreeCAD worker response exceeded its frame limit");
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const text = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!text.trim()) continue;
      let frame: Frame;
      try { frame = JSON.parse(text) as Frame; }
      catch {
        this.stop(`FreeCAD worker returned invalid JSON: ${text.slice(0, 200)}`);
        return;
      }
      const pending = this.pending;
      if (!pending || frame.id !== pending.id) {
        this.stop(`FreeCAD worker returned unexpected response id ${String(frame.id)}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending = null;
      if (frame.ok) pending.resolve(frame.result);
      else {
        const error = frame.error ?? { code: "INTERNAL_ERROR", message: "FreeCAD worker failed without an error" };
        const detail = error.code === "INTERNAL_ERROR" ? { ...(error.detail ?? {}), stderrTail: this.stderrText() } : error.detail;
        pending.reject(new PartOpError(error.message, {
          code: error.code,
          ...(error.target !== undefined ? { target: error.target } : {}),
          ...(detail !== undefined ? { detail } : {}),
          ...(error.hints !== undefined ? { hints: error.hints } : {}),
          ...(error.rolledBack !== undefined ? { rolledBack: error.rolledBack } : {}),
        }));
      }
    }
  }

  private fail(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const reject = this.pending.reject;
    this.pending = null;
    reject(error);
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop("FreeCAD worker idle"), IDLE_EXIT_MS);
    this.idle.unref();
  }

  private setReferenced(child: InteractiveProcess, referenced: boolean): void {
    const method = referenced ? "ref" : "unref";
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as Record<string, (() => void) | undefined>)[method]?.();
    }
  }
}

/** A result that names a document (`fcstd`) must name the one the request asked for; never hand back another document's answer. */
function assertSameDocument(request: PartRequest, result: unknown): void {
  const named = (result as { fcstd?: unknown } | null)?.fcstd;
  if (typeof named !== "string" || resolve(named) === resolve(request.doc)) return;
  throw new PartOpError(`the FreeCAD worker answered ${request.op} for ${named} instead of ${request.doc}`, {
    code: "DOCUMENT_MISMATCH",
    target: request.doc,
    detail: { requested: request.doc, answered: named },
    hints: ["retry the request", "document requests are processed one at a time per project"],
    rolledBack: false,
  });
}

const workers = new Map<string, PartWorker>();

process.once("exit", () => {
  for (const worker of [...workers.values()]) worker.stop("parent process exited");
});

export function runPartCommand(cwd: string, request: PartRequest): Promise<unknown> {
  const key = resolve(cwd);
  let worker = workers.get(key);
  if (!worker) {
    // The PartWorker object outlives its child process: queued requests and the
    // reopen list belong to it, so a stopped child must not drop it from the map.
    worker = new PartWorker(key, () => {});
    workers.set(key, worker);
  }
  return worker.run(request);
}

export function shutdownPartWorkers(): void {
  for (const worker of [...workers.values()]) worker.stop();
  workers.clear();
}
