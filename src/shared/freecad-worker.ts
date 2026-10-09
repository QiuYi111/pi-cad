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

import { packageRoot } from "./paths.ts";
import { NdjsonWorker, NdjsonWorkerRegistry, type NdjsonChild, type NdjsonLaunch, type NdjsonOutcome, type NdjsonProtocol } from "./ndjson-worker.ts";

export const IDLE_EXIT_MS = 10 * 60_000;
export const DEFAULT_BUDGET_S = 30;
export const DEFAULT_MAX_BUDGET_S = 600;
/** Seconds a worker may run past its budget before it is killed (tests shorten it). */
function killGraceSeconds(): number {
  const parsed = Number(process.env.PI_CAD_PART_KILL_GRACE_S ?? 5);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
}
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

/** What one request puts on the wire; the worker echoes `id` back. */
interface Wire {
  op: string;
  doc: string;
  args: Record<string, unknown>;
  budgetS: number;
}

function freecadLaunch(runtime: FreecadRuntime, cwd: string): NdjsonLaunch {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  // The worker has its own interpreter; the uv environment's search path
  // would shadow FreeCAD's modules.
  delete env.PYTHONHOME;
  delete env.VIRTUAL_ENV;
  env.PYTHONPATH = [join(packageRoot(), "python"), runtime.libPath].join(":");
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM ?? "offscreen";
  return { command: runtime.python, args: ["-m", "reify_freecad.worker"], cwd: resolve(cwd), env };
}

const PROTOCOL: NdjsonProtocol<Wire, unknown> = {
  name: "FreeCAD",
  wireId: (n) => `r-${n}`,
  encode: (id, request) => ({ id, op: request.op, doc: request.doc, args: request.args, budgetS: request.budgetS }),
  decode: (frame, stderrTail): NdjsonOutcome<unknown> => {
    const reply = frame as Frame;
    if (reply.ok) return { ok: true, value: reply.result };
    const error = reply.error ?? { code: "INTERNAL_ERROR", message: "FreeCAD worker failed without an error" };
    const detail = error.code === "INTERNAL_ERROR" ? { ...(error.detail ?? {}), stderrTail } : error.detail;
    return {
      ok: false,
      error: new PartOpError(error.message, {
        code: error.code,
        ...(error.target !== undefined ? { target: error.target } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(error.hints !== undefined ? { hints: error.hints } : {}),
        ...(error.rolledBack !== undefined ? { rolledBack: error.rolledBack } : {}),
      }),
    };
  },
  restartError: (message, stderrTail) => new PartOpError(message, {
    code: "FREECAD_WORKER_RESTARTED", hints: ["retry"], detail: { stderrTail },
  }),
  killSignal: "SIGKILL",
  stderrTailBytes: STDERR_TAIL_BYTES,
  idleMs: IDLE_EXIT_MS,
  admissionError: () => new PartOpError("request cancelled", { code: "CANCELLED" }),
  abortError: () => new PartOpError("request cancelled", { code: "CANCELLED", rolledBack: true }),
};

class PartWorker {
  private readonly io: NdjsonWorker<Wire, unknown>;
  /** Documents the live child has open. */
  private openInChild = new Set<string>();
  /** How each document was last opened, to reopen it after a restart. */
  private readonly openArgs = new Map<string, Record<string, unknown>>();

  constructor(private readonly cwd: string) {
    this.io = new NdjsonWorker(PROTOCOL, () => this.openInChild.clear());
  }

  run(request: PartRequest): Promise<unknown> {
    return this.io.serial(() => this.runOne(request));
  }

  stop(reason?: string): void {
    this.io.stop(reason);
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
    return this.io.withChild(() => freecadLaunch(runtime, this.cwd), async (child) => {
      if (request.op === "open") this.openArgs.set(request.doc, { ...(request.args ?? {}), export: true });
      if (request.op !== "open" && !this.openInChild.has(request.doc)) {
        let reopen = this.openArgs.get(request.doc);
        if (!reopen && request.ensureOpen && existsSync(request.doc)) {
          reopen = { ...request.ensureOpen, export: true };
          this.openArgs.set(request.doc, reopen);
        }
        if (reopen) await this.send(child, { op: "open", doc: request.doc, args: { ...reopen, create: false, export: false }, budgetS }, budgetS, request.signal);
      }
      const result = await this.send(child, { op: request.op, doc: request.doc, args: request.args ?? {}, budgetS }, budgetS, request.signal);
      assertSameDocument(request, result);
      if (request.op === "open") this.openInChild.add(request.doc);
      if (request.op === "close") { this.openInChild.delete(request.doc); this.openArgs.delete(request.doc); }
      return result;
    }, request.signal);
  }

  private send(child: NdjsonChild, wire: Wire, budgetS: number, signal?: AbortSignal): Promise<unknown> {
    return this.io.exchange(child, wire, {
      timeoutMs: (budgetS + killGraceSeconds()) * 1000,
      timeoutError: () => new PartOpError(`${wire.op} exceeded its budget of ${budgetS}s and was stopped`, {
        code: "BUDGET_EXCEEDED",
        detail: { budgetS, stderrTail: this.io.stderrText() },
        hints: ["increase budget_s", "split the check", "the worker was restarted; the document is at its last committed revision, so undo is not needed"],
      }),
      signal,
    });
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

const workers = new NdjsonWorkerRegistry<PartWorker>();

export function runPartCommand(cwd: string, request: PartRequest): Promise<unknown> {
  // The PartWorker object outlives its child process: queued requests and the
  // reopen list belong to it, so a stopped child must not drop it from the map.
  const key = resolve(cwd);
  return workers.get(key, () => new PartWorker(key)).run(request);
}

export function shutdownPartWorkers(): void {
  workers.stopAll();
}
