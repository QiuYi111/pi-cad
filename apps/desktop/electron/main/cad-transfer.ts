/**
 * CAD transfer dispatcher (docs/cad-transfer/protocol.md, sections 2 and 3).
 *
 * The same `runJob` serves the spool (sidecar requests in the project) and the
 * Desktop UI. Every host service is injected, so tests need no real machine.
 */
import { posix } from "node:path";
import { STATE_TEXT } from "../../src/shared/cad-transfer-guide.js";
import type {
  CadTransferError, CadTransferErrorCode, CadTransferEvent, CadTransferJob, CadTransferJobPhase, CadTransferState,
  CadTransferStatus, CadTransferTarget, CadTransferTargetStatus, CadTransferTestResult,
} from "../../src/shared/contracts.js";
import { detectFusion, detectSolidworks, type DetectDeps } from "./cad-transfer-detect.js";
import { installFusionAddin } from "./cad-transfer-install.js";
import {
  SPOOL_DIR, hostPath, isProjectRelative, isSafeJobId, layoutFor, newJobId, type ProjectIO, type RunningProcess,
} from "./cad-transfer-paths.js";

export const REQUEST_SCHEMA = "reify.transfer.request/1";
export const JOB_SCHEMA = "reify.transfer.job/1";
export const EXECUTOR_RESULT_SCHEMA = "reify.transfer.result/1";
export const SPOOL_RESULT_SCHEMA = "reify.transfer.spool-result/1";
export const DISPATCHER_SCHEMA = "reify.transfer.dispatcher/1";

export const DEFAULT_TIMEOUT_S = 300;
export const MAX_TIMEOUT_S = 3600;
const EXECUTOR_POLL_MS = 500;
const SPOOL_POLL_MS = 1000;
const HEARTBEAT_MS = 5000;
const STATUS_CACHE_MS = 2000;
const TARGETS: CadTransferTarget[] = ["fusion", "solidworks"];
const DISPATCHER_MAX_AGE_S = 15;
/** Sidecar waits up to timeoutS + 60 s, then runs the shape check. */
const AGENT_EXPORT_TIMEOUT_MS = 8 * 60_000;

export interface DispatchRequest {
  jobId?: string;
  target: CadTransferTarget;
  /** A project-relative features.json path (spool) or the canonical feature JSON itself (UI). */
  features?: string | Record<string, unknown>;
  /** "assembly": `assembly` replaces `features` (protocol section 6). */
  kind?: "part" | "assembly";
  /** A project-relative reify.assembly/1 JSON path (spool) or the assembly object itself. */
  assembly?: string | Record<string, unknown>;
  native: string;
  checkStep?: string;
  check?: boolean;
  timeoutS?: number;
  part?: string;
}

export interface SpoolResult {
  schema: typeof SPOOL_RESULT_SCHEMA;
  jobId: string;
  ok: boolean;
  target: CadTransferTarget;
  executor?: Record<string, unknown>;
  files: { native?: string; check_step?: string; log?: string; extra?: string[] };
  features_built?: number;
  feature_volumes?: Array<{ name: string; volume_mm3: number }>;
  error: CadTransferError | null;
  durationS: number;
}

export type AgentRequester = (body: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

export interface CadTransferDeps extends DetectDeps {
  pid: number;
  emit?: (event: CadTransferEvent) => void;
  agent?: AgentRequester;
  random?: () => number;
}

interface JobContext {
  jobId: string;
  request: DispatchRequest;
  io: ProjectIO;
  job: CadTransferJob;
  cancelled: boolean;
  process?: RunningProcess;
  resolve: (result: SpoolResult) => void;
  startedAt?: number;
  logHost?: string;
  logProject?: string;
  /** Status writes of one job run in order. */
  writes: Promise<void>;
}

const EXECUTOR_CODES = new Set<CadTransferErrorCode>(["EXECUTOR_FAILED", "UNSUPPORTED_OP", "BUSY"]);

/** The reference plate of the Settings "Test export": 40 x 30 x 5 mm, 4 through holes, 1 pocket. */
export const REFERENCE_PLATE_BODY = "plate";
export const REFERENCE_PLATE_OPS = [
  { op: "sketch", name: "plate/profile", plane: "XY", shapes: [{ rect: { center: [0, 0], size: [40, 30] } }] },
  { op: "pad", name: "plate/base", sketch: "plate/profile", length: 5 },
  {
    op: "sketch", name: "plate/hole_profile", on: { feature: "plate/base", role: "top" },
    shapes: [
      { circle: { center: [-15, -10], diameter: 4 } }, { circle: { center: [15, -10], diameter: 4 } },
      { circle: { center: [-15, 10], diameter: 4 } }, { circle: { center: [15, 10], diameter: 4 } },
    ],
  },
  { op: "hole", name: "plate/holes", sketch: "plate/hole_profile", diameter: 4, type: "through_all" },
  {
    op: "sketch", name: "plate/pocket_profile", on: { feature: "plate/base", role: "top" },
    shapes: [{ rect: { center: [0, 0], size: [10, 6] } }],
  },
  { op: "pocket", name: "plate/pocket", sketch: "plate/pocket_profile", depth: 2 },
];

export function nativeExtension(target: CadTransferTarget, assembly = false): string {
  return target === "fusion" ? "f3d" : assembly ? "SLDASM" : "SLDPRT";
}

/** Target states of dispatcher.json, or "unavailable" when the file is missing or stale (> 15 s). */
export function evaluateDispatcherFile(
  text: string | null, nowMs: number,
): { alive: boolean; targets: Record<CadTransferTarget, CadTransferState> } {
  const dead = { alive: false, targets: { fusion: "unavailable", solidworks: "unavailable" } as Record<CadTransferTarget, CadTransferState> };
  if (!text) return dead;
  try {
    const parsed = JSON.parse(text) as { updatedAt?: string; targets?: Partial<Record<CadTransferTarget, CadTransferState>> };
    const updated = parsed.updatedAt ? Date.parse(parsed.updatedAt) : NaN;
    if (!Number.isFinite(updated) || (nowMs - updated) / 1000 > DISPATCHER_MAX_AGE_S) return dead;
    return {
      alive: true,
      targets: { fusion: parsed.targets?.fusion ?? "unavailable", solidworks: parsed.targets?.solidworks ?? "unavailable" },
    };
  } catch { return dead; }
}

function failure(code: CadTransferErrorCode, message: string, extra: Partial<CadTransferError> = {}): CadTransferError {
  return { code, message, ...extra };
}

export class CadTransferService {
  private project: ProjectIO | null = null;
  private active = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly seen = new Set<string>();
  /** Jobs that an agent call owns: their final state comes from the agent answer. */
  private readonly agentJobs = new Set<string>();
  private readonly cancelledJobs = new Set<string>();
  private readonly logHosts = new Map<string, string>();
  private readonly jobs = new Map<string, JobContext>();
  private readonly queues: Record<CadTransferTarget, JobContext[]> = { fusion: [], solidworks: [] };
  private readonly busy: Record<CadTransferTarget, boolean> = { fusion: false, solidworks: false };
  private cached: { at: number; status: CadTransferStatus } | null = null;
  private lastStatusKey = "";

  constructor(private readonly deps: CadTransferDeps) {}

  // ---- status -----------------------------------------------------------------------------

  private detectTarget(target: CadTransferTarget): Promise<CadTransferTargetStatus> {
    return target === "fusion" ? detectFusion(this.deps) : detectSolidworks(this.deps);
  }

  async getStatus(refresh = false): Promise<CadTransferStatus> {
    const { clock, host } = this.deps;
    if (!refresh && this.cached && clock.now() - this.cached.at < STATUS_CACHE_MS) return this.cached.status;
    const [fusion, solidworks] = await Promise.all([this.detectTarget("fusion"), this.detectTarget("solidworks")]);
    const status: CadTransferStatus = {
      platform: host.platform,
      projectInWsl: this.deps.projectInWsl,
      dispatcherActive: this.active,
      jobRoot: layoutFor(host).jobRoot,
      checkedAt: new Date(clock.now()).toISOString(),
      targets: { fusion, solidworks },
    };
    this.cached = { at: clock.now(), status };
    const key = JSON.stringify({ ...status, checkedAt: "" });
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.deps.emit?.({ type: "status", status });
    }
    return status;
  }

  async installFusionAddin(): Promise<CadTransferStatus> {
    await installFusionAddin(this.deps);
    return this.getStatus(true);
  }

  // ---- lifecycle --------------------------------------------------------------------------

  setProject(io: ProjectIO | null): void { this.project = io; }

  /** Start the heartbeat and the spool watcher for a project. Call again to switch project. */
  async start(io: ProjectIO): Promise<void> {
    await this.stop();
    this.project = io;
    this.active = true;
    await this.writeHeartbeat();
    // Poll with timers, not fs.watch: fs.watch does not work over \\wsl$.
    this.pollTimer = setInterval(() => { void this.pollSpool(); }, io.spoolPollMs ?? SPOOL_POLL_MS);
    this.beatTimer = setInterval(() => { void this.writeHeartbeat(); }, HEARTBEAT_MS);
  }

  /** Stop the timers. The old updatedAt makes the sidecar see "no dispatcher" at once. */
  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.pollTimer = this.beatTimer = null;
    const io = this.project;
    const wasActive = this.active;
    this.active = false;
    if (io && wasActive) {
      const targets = { fusion: "unavailable", solidworks: "unavailable" };
      await io.writeTextAtomic(`${SPOOL_DIR}/dispatcher.json`, JSON.stringify({
        schema: DISPATCHER_SCHEMA, pid: this.deps.pid, updatedAt: new Date(0).toISOString(), stopped: true, targets,
        detail: { fusion: STATE_TEXT.fusion.unavailable, solidworks: STATE_TEXT.solidworks.unavailable },
      }, null, 2)).catch(() => undefined);
    }
  }

  async writeHeartbeat(): Promise<void> {
    const io = this.project;
    if (!io || !this.active) return;
    const status = await this.getStatus(true);
    const body = {
      schema: DISPATCHER_SCHEMA,
      pid: this.deps.pid,
      updatedAt: new Date(this.deps.clock.now()).toISOString(),
      targets: { fusion: status.targets.fusion.state, solidworks: status.targets.solidworks.state },
      detail: { fusion: status.targets.fusion.detail, solidworks: status.targets.solidworks.detail },
    };
    await io.writeTextAtomic(`${SPOOL_DIR}/dispatcher.json`, `${JSON.stringify(body, null, 2)}\n`).catch(() => undefined);
  }

  // ---- spool ------------------------------------------------------------------------------

  /** One pass over requests/ and cancel/. Called every second. */
  async pollSpool(): Promise<void> {
    const io = this.project;
    if (!io || !this.active || this.polling) return;
    this.polling = true;
    try {
      const requests = await io.readdir(`${SPOOL_DIR}/requests`).catch(() => [] as string[]);
      for (const name of requests) {
        if (!name.endsWith(".json") || name.startsWith(".")) continue;
        const id = name.slice(0, -".json".length);
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        void this.handleSpoolRequest(io, id);
      }
      const cancels = await io.readdir(`${SPOOL_DIR}/cancel`).catch(() => [] as string[]);
      for (const id of cancels) {
        if (id.startsWith(".")) continue;
        if (this.cancel(id)) await io.remove(`${SPOOL_DIR}/cancel/${id}`).catch(() => undefined);
        else if (await io.exists(`${SPOOL_DIR}/results/${id}.json`)) await io.remove(`${SPOOL_DIR}/cancel/${id}`).catch(() => undefined);
      }
    } finally { this.polling = false; }
  }

  private async handleSpoolRequest(io: ProjectIO, id: string): Promise<void> {
    const write = (name: string, value: unknown) => io.writeTextAtomic(`${SPOOL_DIR}/${name}/${id}.json`, `${JSON.stringify(value, null, 2)}\n`);
    const finish = (target: CadTransferTarget, error: CadTransferError) => write("results", this.resultOf(id, target, false, {}, error, 0)).catch(() => undefined);
    try {
      if (!isSafeJobId(id)) return;
      if (await io.exists(`${SPOOL_DIR}/results/${id}.json`)) return; // answered before a restart
      const text = await io.readText(`${SPOOL_DIR}/requests/${id}.json`);
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(text ?? "") as Record<string, unknown>; }
      catch { await finish("fusion", failure("EXECUTOR_FAILED", "The transfer request is not valid JSON.")); return; }
      const target = raw.target === "solidworks" ? "solidworks" : raw.target === "fusion" ? "fusion" : null;
      if (!target || raw.schema !== REQUEST_SCHEMA || raw.jobId !== id
        || (raw.kind === "assembly" ? typeof raw.assembly !== "string" : typeof raw.features !== "string")) {
        await finish(target ?? "fusion", failure("EXECUTOR_FAILED", "The transfer request has a wrong schema, job id, target, or features or assembly path."));
        return;
      }
      if (await io.exists(`${SPOOL_DIR}/cancel/${id}`)) {
        await finish(target, failure("CANCELLED", "The export was cancelled."));
        await io.remove(`${SPOOL_DIR}/cancel/${id}`).catch(() => undefined);
        return;
      }
      const status = await io.readText(`${SPOOL_DIR}/status/${id}.json`);
      if (status) {
        try {
          const state = (JSON.parse(status) as { state?: string }).state;
          if (state === "queued" || state === "running") {
            await finish(target, failure("EXECUTOR_FAILED", "Reify restarted while this job was running. Send the request again."));
            return;
          }
        } catch { /* An unreadable status file does not block the job. */ }
      }
      await this.runJob({
        jobId: id, target,
        ...(raw.kind === "assembly" ? { kind: "assembly" as const, assembly: raw.assembly as string } : { features: raw.features as string }),
        native: String(raw.native ?? ""),
        checkStep: typeof raw.checkStep === "string" ? raw.checkStep : undefined,
        check: raw.check !== false, timeoutS: typeof raw.timeoutS === "number" ? raw.timeoutS : undefined,
      }, io);
    } catch (error) {
      await finish("fusion", failure("EXECUTOR_FAILED", `The dispatcher failed: ${String((error as Error).message ?? error)}`));
    }
  }

  // ---- jobs -------------------------------------------------------------------------------

  /** Run one job. It queues behind the running job of the same target. Never rejects. */
  runJob(request: DispatchRequest, io: ProjectIO | null = this.project): Promise<SpoolResult> {
    const started = this.deps.clock.now();
    const jobId = request.jobId ?? newJobId(started, this.deps.random);
    const early = (error: CadTransferError) => Promise.resolve(this.resultOf(jobId, request.target, false, {}, error, 0));
    if (!io) return early(failure("EXECUTOR_FAILED", "Choose a project before an export."));
    if (!TARGETS.includes(request.target)) return early(failure("EXECUTOR_FAILED", "Unknown export target."));
    if (!isSafeJobId(jobId)) return early(failure("EXECUTOR_FAILED", "The job id has characters that are not allowed."));
    if (this.jobs.has(jobId)) return early(failure("BUSY", "A job with this id is already active."));
    if (!isProjectRelative(request.native)) return early(failure("EXECUTOR_FAILED", "The native file path must stay inside the project."));
    if (request.checkStep !== undefined && !isProjectRelative(request.checkStep)) {
      return early(failure("EXECUTOR_FAILED", "The check STEP path must stay inside the project."));
    }
    if (typeof request.features === "string" && !isProjectRelative(request.features)) {
      return early(failure("EXECUTOR_FAILED", "The features path must stay inside the project."));
    }
    if (typeof request.assembly === "string" && !isProjectRelative(request.assembly)) {
      return early(failure("EXECUTOR_FAILED", "The assembly path must stay inside the project."));
    }
    const isAssembly = request.kind === "assembly";
    if (isAssembly ? request.assembly === undefined : request.features === undefined) {
      return early(failure("EXECUTOR_FAILED", isAssembly ? "The assembly request has no assembly." : "The request has no features."));
    }
    return new Promise<SpoolResult>((resolve) => {
      const ctx: JobContext = {
        jobId, request, io, cancelled: false, resolve, writes: Promise.resolve(),
        job: { jobId, target: request.target, state: "queued", message: "Waiting for the CAD program.", updatedAt: "", part: request.part },
      };
      this.jobs.set(jobId, ctx);
      void this.setPhase(ctx, "queued", this.busy[request.target] ? "Another export is running. This job waits." : "Waiting for the CAD program.");
      this.queues[request.target].push(ctx);
      void this.pump(request.target);
    });
  }

  /** Cancel a queued or running job. Returns false for an unknown job. */
  cancel(jobId: string): boolean {
    const ctx = this.jobs.get(jobId);
    if (!ctx) {
      if (!this.agentJobs.has(jobId)) return false;
      // The sidecar has not written the request yet. Leave a cancel file for the spool.
      this.cancelledJobs.add(jobId);
      void this.project?.writeTextAtomic(`${SPOOL_DIR}/cancel/${jobId}`, "").catch(() => undefined);
      return true;
    }
    if (this.agentJobs.has(jobId)) this.cancelledJobs.add(jobId);
    ctx.cancelled = true;
    ctx.process?.kill();
    const queue = this.queues[ctx.request.target];
    const index = queue.indexOf(ctx);
    if (index >= 0) {
      queue.splice(index, 1);
      void this.finish(ctx, failure("CANCELLED", "The export was cancelled."), {}, {});
    }
    return true;
  }

  private async pump(target: CadTransferTarget): Promise<void> {
    if (this.busy[target]) return;
    const next = this.queues[target].shift();
    if (!next) return;
    this.busy[target] = true;
    try { await this.execute(next); }
    catch (error) { await this.finish(next, failure("EXECUTOR_FAILED", String((error as Error).message ?? error)), {}, {}); }
    finally {
      this.busy[target] = false;
      void this.pump(target);
    }
  }

  private async setPhase(ctx: JobContext, state: CadTransferJobPhase, message: string, patch: Partial<CadTransferJob> = {}): Promise<void> {
    ctx.job = { ...ctx.job, ...patch, state, message, updatedAt: new Date(this.deps.clock.now()).toISOString() };
    // The executor part is done, but the agent still checks the shape: the final state comes from the agent.
    this.deps.emit?.({
      type: "job",
      job: state === "done" && this.agentJobs.has(ctx.jobId) ? { ...ctx.job, state: "running", message: "Checking the shape." } : ctx.job,
    });
    const text = `${JSON.stringify({ jobId: ctx.jobId, state, message, updatedAt: ctx.job.updatedAt }, null, 2)}\n`;
    ctx.writes = ctx.writes.then(() => ctx.io.writeTextAtomic(`${SPOOL_DIR}/status/${ctx.jobId}.json`, text).catch(() => undefined));
    await ctx.writes;
  }

  private resultOf(
    jobId: string, target: CadTransferTarget, ok: boolean, executor: Record<string, unknown>,
    error: CadTransferError | null, durationS: number, files: SpoolResult["files"] = {},
  ): SpoolResult {
    return {
      schema: SPOOL_RESULT_SCHEMA, jobId, ok, target,
      ...(executor.executor ? { executor: executor.executor as Record<string, unknown> } : {}),
      files,
      ...(typeof executor.features_built === "number" ? { features_built: executor.features_built } : {}),
      ...(Array.isArray(executor.feature_volumes) ? { feature_volumes: executor.feature_volumes as SpoolResult["feature_volumes"] } : {}),
      error, durationS,
    };
  }

  private async finish(
    ctx: JobContext, error: CadTransferError | null, executor: Record<string, unknown>, files: SpoolResult["files"],
  ): Promise<void> {
    const durationS = Math.max(0, (this.deps.clock.now() - (ctx.startedAt ?? this.deps.clock.now())) / 1000);
    const result = this.resultOf(ctx.jobId, ctx.request.target, error === null, executor, error, durationS, files);
    const phase: CadTransferJobPhase = error === null ? "done" : error.code === "CANCELLED" ? "cancelled" : "failed";
    const message = error === null ? "Export done." : error.feature ? `${error.message} (feature ${error.feature})` : error.message;
    let nativeFolder: string | undefined;
    if (files.native) nativeFolder = await ctx.io.toHostPath(posix.dirname(files.native)).catch(() => undefined);
    await ctx.io.writeTextAtomic(`${SPOOL_DIR}/results/${ctx.jobId}.json`, `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
    if (ctx.logHost) {
      this.logHosts.set(ctx.jobId, ctx.logHost);
      if (this.logHosts.size > 50) this.logHosts.delete(this.logHosts.keys().next().value as string);
    }
    await this.setPhase(ctx, phase, message, {
      error, ...(ctx.logHost ? { logPath: ctx.logHost } : {}), ...(files.native ? { native: files.native } : {}), ...(nativeFolder ? { nativeFolder } : {}),
    });
    this.jobs.delete(ctx.jobId);
    ctx.resolve(result);
  }

  private async execute(ctx: JobContext): Promise<void> {
    const { request, io, jobId } = ctx;
    const { clock, fs, host } = this.deps;
    ctx.startedAt = clock.now();
    if (ctx.cancelled) return this.finish(ctx, failure("CANCELLED", "The export was cancelled."), {}, {});
    await this.setPhase(ctx, "running", "Checking the CAD program.");
    const status = await this.detectTarget(request.target);
    if (status.state !== "ready") {
      return this.finish(ctx, failure("TARGET_NOT_READY", status.detail, { step: status.state }), {}, {});
    }

    const isAssembly = request.kind === "assembly";
    let features: Record<string, unknown>;
    try {
      const source = (isAssembly ? request.assembly : request.features)!;
      if (typeof source === "string") {
        const text = await io.readText(source);
        if (text === null) throw new Error(`Reify cannot read ${source}.`);
        features = JSON.parse(text) as Record<string, unknown>;
      } else features = source;
    } catch (error) {
      return this.finish(ctx, failure("EXECUTOR_FAILED", `The feature file is not usable: ${String((error as Error).message ?? error)}`), {}, {});
    }

    const p = hostPath(host.platform);
    const layout = layoutFor(host);
    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, request.timeoutS ?? DEFAULT_TIMEOUT_S));
    const check = request.check !== false;
    const job = {
      schema: JOB_SCHEMA, jobId, target: request.target,
      ...(isAssembly ? { kind: "assembly", assembly: features } : { features }),
      output: { native: `part.${nativeExtension(request.target, isAssembly)}`, check_step: "check.step" },
      check, timeoutS,
    };
    const jobText = `${JSON.stringify(job)}\n`;
    const folder = request.target === "fusion" ? p.join(layout.fusionOutbox, jobId) : p.join(layout.solidworksJobs, jobId);
    const resultFile = p.join(folder, "result.json");
    const deadline = clock.now() + timeoutS * 1000;

    await this.setPhase(ctx, "running", `Exporting to ${request.target === "fusion" ? "Fusion" : "SolidWorks"}.`);
    let inboxFile: string | null = null;
    try {
      await fs.mkdirp(folder);
      if (request.target === "fusion") {
        inboxFile = p.join(layout.fusionInbox, `${jobId}.json`);
        await fs.writeTextAtomic(inboxFile, jobText); // tmp + rename: the add-in never sees a partial file
      } else {
        await fs.writeTextAtomic(p.join(folder, "job.json"), jobText);
      }
    } catch (error) {
      return this.finish(ctx, failure("EXECUTOR_FAILED", `Reify cannot write the job folder: ${String((error as Error).message ?? error)}`), {}, {});
    }

    // Wait for the executor.
    const exit = { done: false, code: null as number | null, stderr: "" };
    if (request.target === "solidworks") {
      const exe = this.deps.bundledSolidworksExe!;
      ctx.process = this.deps.runner.start(exe, ["--job", folder]);
      void ctx.process.done.then(
        (r) => { exit.done = true; exit.code = r.code; exit.stderr = r.stderr; },
        (e) => { exit.done = true; exit.code = -1; exit.stderr = String(e); },
      );
    }
    let resultText: string | null = null;
    let parsed: Record<string, unknown> | null = null;
    let outcome: CadTransferError | null = null;
    for (;;) {
      if (ctx.cancelled) { outcome = failure("CANCELLED", "The export was cancelled."); break; }
      resultText = await fs.readText(resultFile);
      if (resultText) {
        try { parsed = JSON.parse(resultText) as Record<string, unknown>; break; } catch { /* The executor may still write. */ }
      }
      if (exit.done && !parsed) {
        // The program ended. Read once more, then give up.
        resultText = await fs.readText(resultFile);
        try { parsed = resultText ? JSON.parse(resultText) as Record<string, unknown> : null; } catch { parsed = null; }
        if (!parsed) {
          const tail = exit.stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
          outcome = failure("EXECUTOR_FAILED", `ReifyExport ended with code ${exit.code} and wrote no result.${tail ? ` ${tail}` : ""}`);
        }
        break;
      }
      if (clock.now() >= deadline) { outcome = failure("TIMEOUT", `The CAD program did not finish in ${timeoutS} s.`); break; }
      await Promise.race([clock.sleep(EXECUTOR_POLL_MS), ctx.process?.done.then(() => undefined, () => undefined) ?? new Promise<void>(() => undefined)]);
    }
    if (outcome) {
      ctx.process?.kill();
      if (inboxFile) await fs.rm(inboxFile).catch(() => undefined); // not picked up: do not run it later
      await this.copyLog(ctx, folder);
      return this.finish(ctx, outcome, {}, await this.logFiles(ctx));
    }
    const result = parsed!;
    await this.copyLog(ctx, folder);
    const files: SpoolResult["files"] = await this.logFiles(ctx);
    if (result.ok !== true) {
      const raw = (result.error ?? {}) as Record<string, unknown>;
      const code = EXECUTOR_CODES.has(raw.code as CadTransferErrorCode) ? raw.code as CadTransferErrorCode : "EXECUTOR_FAILED";
      return this.finish(ctx, failure(code, String(raw.message ?? "The CAD program reported an error."), {
        ...(typeof raw.feature === "string" ? { feature: raw.feature } : {}),
        ...(typeof raw.step === "string" ? { step: raw.step } : {}),
      }), result, files);
    }

    // Copy the results into the project.
    const names = (result.files ?? {}) as Record<string, unknown>;
    const plain = (value: unknown, fallback: string) => typeof value === "string" && /^[^\\/]+$/.test(value) && value !== ".." ? value : fallback;
    const nativeName = plain(names.native, job.output.native);
    try {
      const nativeSource = p.join(folder, nativeName);
      if (!(await fs.exists(nativeSource))) throw new Error(`The CAD program did not write ${nativeName}.`);
      await io.copyIn(nativeSource, request.native);
      files.native = request.native;
      if (check) {
        const checkName = plain(names.check_step, job.output.check_step);
        const checkSource = p.join(folder, checkName);
        if (!(await fs.exists(checkSource))) throw new Error(`The CAD program did not write ${checkName}.`);
        const checkTarget = request.checkStep ?? `build/transfer/${jobId}/check.step`;
        await io.copyIn(checkSource, checkTarget);
        files.check_step = checkTarget;
      }
      if (Array.isArray(names.extra)) {
        const extras: string[] = [];
        for (const name of names.extra.slice(0, 200)) {
          if (typeof name !== "string" || !/^[^\\/]+$/.test(name) || name === ".." || name === ".") throw new Error("The CAD program listed an extra file with a bad name.");
          const source = p.join(folder, name);
          if (!(await fs.exists(source))) throw new Error(`The CAD program did not write ${name}.`);
          const target = posix.join(posix.dirname(request.native), name);
          await io.copyIn(source, target);
          extras.push(target);
        }
        if (extras.length) files.extra = extras;
      }
    } catch (error) {
      return this.finish(ctx, failure("EXECUTOR_FAILED", `Reify cannot copy the result into the project: ${String((error as Error).message ?? error)}`), result, files);
    }
    ctx.logHost = p.join(folder, "log.txt");
    return this.finish(ctx, null, result, files);
  }

  private async copyLog(ctx: JobContext, folder: string): Promise<void> {
    const p = hostPath(this.deps.host.platform);
    const log = p.join(folder, "log.txt");
    ctx.logHost = log;
    if (!(await this.deps.fs.exists(log))) { ctx.logProject = undefined; return; }
    const target = `${SPOOL_DIR}/logs/${ctx.jobId}.log`;
    try { await ctx.io.copyIn(log, target); ctx.logProject = target; } catch { ctx.logProject = undefined; }
  }

  private async logFiles(ctx: JobContext): Promise<SpoolResult["files"]> {
    return ctx.logProject ? { log: ctx.logProject } : {};
  }

  // ---- UI export --------------------------------------------------------------------------

  /** Find the FreeCAD part document that belongs to a built artifact (build/<stem>.step). */
  async resolvePartDoc(artifactPath: string, io: ProjectIO | null = this.project): Promise<string> {
    if (!io) throw new Error("Choose a project before an export.");
    const relative = artifactPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (/\.FCStd$/i.test(relative)) return relative;
    const stem = posix.basename(relative).replace(/\.[^.]+$/, "");
    const candidates = [
      `parts/${stem}.FCStd`, `${stem}.FCStd`, `models/${stem}.FCStd`,
      `assembly/${stem}.FCStd`, `assemblies/${stem}.FCStd`,
    ];
    for (const candidate of candidates) if (await io.exists(candidate)) return candidate;
    throw new Error(`Reify cannot find the part file for ${posix.basename(relative)}. Only FreeCAD parts and assemblies can go to a CAD program.`);
  }

  /**
   * Export through the agent (`transfer-export`), the same path the agent uses. The sidecar writes the spool
   * request and this dispatcher serves it, so progress, cancel and the queue use one job id. The final state
   * comes from the agent answer, because only the sidecar knows the result of the shape check.
   */
  private async exportViaAgent(
    io: ProjectIO, args: { jobId: string; target: CadTransferTarget; doc: string; native?: string; part?: string },
  ): Promise<{ job: CadTransferJob; response?: Record<string, unknown> }> {
    const { jobId, target, doc, native, part } = args;
    const base = (state: CadTransferJobPhase, message: string, extra: Partial<CadTransferJob> = {}): CadTransferJob =>
      ({ jobId, target, state, message, part, updatedAt: new Date(this.deps.clock.now()).toISOString(), ...extra });
    this.agentJobs.add(jobId);
    let job: CadTransferJob;
    let response: Record<string, unknown> | undefined;
    try {
      if (!this.deps.agent) throw new Error("The Reify runtime is not ready.");
      response = await this.deps.agent({ op: "transfer-export", doc, target, ...(native ? { output: native } : {}), check: true, jobId }, AGENT_EXPORT_TIMEOUT_MS) as Record<string, unknown>;
      const file = typeof response.file === "string" ? response.file : native;
      if (!file) throw new Error("The export gave no file path.");
      const log = typeof response.log === "string" ? response.log : undefined;
      const nativeFolder = await io.toHostPath(posix.dirname(file)).catch(() => undefined);
      const logPath = log ? await io.toHostPath(log).catch(() => log) : undefined;
      const notes = Array.isArray(response.notes) ? response.notes.filter((note): note is string => typeof note === "string") : [];
      const outcome = response.check === "passed" ? "Export done. The shape check passed." : "Export done.";
      job = base("done", notes.length ? `${outcome} Joints were not exported; the parts keep the pose they had.` : outcome, {
        native: file, ...(nativeFolder ? { nativeFolder } : {}), ...(logPath ? { logPath } : {}), error: null,
      });
    } catch (error) {
      const e = error as { message?: string; code?: string; target?: string; detail?: { feature?: unknown; log?: unknown } };
      const feature = typeof e.target === "string" ? e.target : typeof e.detail?.feature === "string" ? e.detail.feature : undefined;
      const code = (e.code && /^(TRANSFER_[A-Z_]+|BAD_REQUEST)$/.test(e.code) ? e.code : "TRANSFER_EXECUTOR_FAILED") as CadTransferError["code"];
      const message = String(e.message ?? error);
      const log = typeof e.detail?.log === "string" ? e.detail.log : undefined;
      const logPath = log ? await io.toHostPath(log).catch(() => log) : this.logHosts.get(jobId);
      const cancelled = this.cancelledJobs.has(jobId);
      job = base(cancelled ? "cancelled" : "failed", cancelled ? "The export was cancelled." : feature ? `${message} (feature ${feature})` : message, {
        error: cancelled ? failure("CANCELLED", "The export was cancelled.") : { code, message, ...(feature ? { feature } : {}) },
        ...(logPath ? { logPath } : {}),
      });
    } finally {
      this.agentJobs.delete(jobId);
      this.cancelledJobs.delete(jobId);
    }
    this.deps.emit?.({ type: "job", job });
    return { job, response };
  }

  /** Start an export for the Workbench. Returns the queued job at once. Progress arrives as events. */
  startExport(target: CadTransferTarget, artifactPath: string): CadTransferJob {
    const io = this.project;
    const jobId = newJobId(this.deps.clock.now(), this.deps.random);
    const stem = posix.basename(artifactPath.replace(/\\/g, "/")).replace(/\.[^.]+$/, "") || "part";
    const job: CadTransferJob = {
      jobId, target, state: "queued", message: "Preparing the export.", updatedAt: new Date(this.deps.clock.now()).toISOString(), part: stem,
    };
    this.agentJobs.add(jobId); // cancel() works from the first second
    this.deps.emit?.({ type: "job", job });
    void (async () => {
      try {
        if (!io) throw new Error("Choose a project before an export.");
        const doc = await this.resolvePartDoc(artifactPath, io);
        this.agentJobs.delete(jobId);
        // No `output`: the sidecar picks exports/<stem>.<ext> from the real document kind.
        await this.exportViaAgent(io, { jobId, target, doc, part: stem });
      } catch (error) {
        this.agentJobs.delete(jobId);
        const message = String((error as Error).message ?? error);
        this.deps.emit?.({
          type: "job",
          job: { ...job, state: "failed", message, updatedAt: new Date(this.deps.clock.now()).toISOString(), error: failure("EXECUTOR_FAILED", message) },
        });
      }
    })();
    return job;
  }

  /** Build the reference plate in the project and send it through the real export path (`transfer-export`). */
  async testExport(target: CadTransferTarget): Promise<CadTransferTestResult> {
    const steps: CadTransferTestResult["steps"] = [];
    const done = (ok: boolean, message: string, extra: Partial<CadTransferTestResult> = {}): CadTransferTestResult =>
      ({ ok, target, message, steps, ...extra });
    const io = this.project;
    const agent = this.deps.agent;
    if (!io || !agent) return done(false, "Start a project first. Test export needs the Reify runtime.");
    const status = await this.detectTarget(target);
    steps.push({ name: "CAD program ready", ok: status.state === "ready", detail: status.detail });
    if (status.state !== "ready") return done(false, status.detail);

    const stamp = String(this.deps.clock.now());
    const doc = `build/transfer-test/plate-${stamp}.FCStd`;
    try {
      await agent({ op: "part-open", doc, body: REFERENCE_PLATE_BODY, create: true }, 120_000);
      await agent({ op: "part-apply", doc, ops: REFERENCE_PLATE_OPS, message: "reference plate for the transfer test" }, 180_000);
      steps.push({ name: "Reference plate built", ok: true });
    } catch (error) {
      steps.push({ name: "Reference plate built", ok: false, detail: String((error as Error).message ?? error) });
      return done(false, `Reify could not build the reference plate. ${String((error as Error).message ?? error)}`);
    }
    const jobId = newJobId(this.deps.clock.now(), this.deps.random);
    this.deps.emit?.({ type: "job", job: { jobId, target, state: "queued", message: "Preparing the export.", part: "Reference plate", updatedAt: new Date(this.deps.clock.now()).toISOString() } });
    const { job } = await this.exportViaAgent(io, {
      jobId, target, doc, native: `build/transfer-test/plate-${stamp}.${nativeExtension(target)}`, part: "Reference plate",
    });
    const logPath = job.logPath ?? this.logHosts.get(jobId);
    steps.push({ name: "CAD program exported", ok: job.state === "done", detail: job.error?.message });
    if (job.state !== "done") {
      return done(false, `${job.error?.code ?? "FAILED"}: ${job.error?.message ?? job.message}`, { logPath, failedFeature: job.error?.feature, job });
    }
    steps.push({ name: "Shape check passed", ok: true });
    return done(true, "Test export passed.", { logPath, job });
  }
}
