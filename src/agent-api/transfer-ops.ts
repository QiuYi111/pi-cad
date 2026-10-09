/**
 * Agent API operations of `cad.transfer`: `transfer-status`, `transfer-features`, `transfer-export`.
 *
 * The FreeCAD worker builds the canonical feature JSON from the recomputed
 * document (read only). The CAD program (Fusion, SolidWorks) runs on the user's
 * machine and is started by the Reify desktop app. This sidecar cannot call the
 * desktop app, so both sides use a spool folder in the project:
 *
 *   .pi-cad/transfer/dispatcher.json         the desktop app writes it every 5 s
 *   .pi-cad/transfer/requests/<job>.json     this module writes a request
 *   .pi-cad/transfer/status/<job>.json       the desktop app writes progress
 *   .pi-cad/transfer/results/<job>.json      the desktop app writes the result
 *   .pi-cad/transfer/cancel/<job>            this module creates it to cancel
 *
 * The wire formats are in docs/cad-transfer/protocol.md.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { jsonValue, type JsonValue } from "../harness/canonical.ts";
import { inspectGeometry } from "../shared/capability.ts";
import { PartOpError } from "../shared/freecad-worker.ts";
import type { GeometryPayload } from "../shared/protocol.ts";
import { partRequest, readDfmSummary, resolvePartPaths } from "./part-ops.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";
import { projectRelativePath } from "./observe.ts";
import { compareEquivalence, type FeatureVolume } from "./transfer-check.ts";

type TransferRequest = Extract<AgentApiRequest, { op: `transfer-${string}` }>;

export const TRANSFER_DIR = ".pi-cad/transfer";
export const DISPATCHER_STALE_MS = 15_000;
export const DEFAULT_TIMEOUT_S = 300;
/** Longest features JSON the agent gets back inline; the file is always written. */
const INLINE_FEATURES_BYTES = 1024 * 1024;
const SETTINGS_HINT = "Open Settings > CAD exports in the Reify desktop app and finish the steps for this target.";

const TARGETS = ["fusion", "solidworks"] as const;
type Target = (typeof TARGETS)[number];
const SUFFIX: Record<Target, RegExp> = { fusion: /\.f3d$/i, solidworks: /\.(sldprt|sldasm)$/i };

/** Test seams: the clock, the poll delay and the geometry inspector. */
export const transferHooks = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms)),
  pollMs: 500,
  /**
   * Run `export_features` in the FreeCAD worker. An assembly document answers with an
   * unsupported-op error for `occurrence`; then `export_assembly` builds `reify.assembly/1`.
   */
  canonicalize: async (cwd: string, doc: string, referenceStepAbs?: string): Promise<unknown> => {
    const paths = resolvePartPaths(cwd, doc);
    const args = referenceStepAbs ? { referenceStep: referenceStepAbs } : {};
    try {
      return { kind: "part", ...(await partRequest(cwd, paths, { op: "export_features", args }) as object) };
    } catch (error) {
      const failure = error as PartOpError;
      if (failure?.code !== "TRANSFER_UNSUPPORTED_OP" || failure.detail?.op !== "assembly") throw error;
      const assembly = await partRequest(cwd, paths, { op: "export_assembly", args }) as {
        assembly: WorkerFeatures["features"]; occurrenceCount: number; part?: string; referenceStep?: string; joints?: JointSummary[];
      };
      return {
        kind: "assembly", features: assembly.assembly, featureCount: assembly.occurrenceCount,
        part: assembly.part ?? basename(paths.docRel, extname(paths.docRel)), referenceStep: assembly.referenceStep,
        joints: assembly.joints ?? [],
      };
    }
  },
  inspect: async (cwd: string, artifactRel: string, outputRel: string): Promise<GeometryPayload> => {
    const envelope = await inspectGeometry(cwd, artifactRel, outputRel);
    if (!envelope.ok) {
      throw new PartOpError(String((envelope.payload as { error?: string } | undefined)?.error ?? "geometry inspection failed"), {
        code: "TRANSFER_CHECK_FAILED", detail: { artifact: artifactRel },
      });
    }
    return envelope.payload as GeometryPayload;
  },
};

interface DispatcherFile {
  schema?: number;
  pid?: number;
  updatedAt?: string;
  targets?: Partial<Record<Target, string>>;
  detail?: Record<string, unknown>;
}

interface SpoolResult {
  jobId: string;
  ok: boolean;
  target: Target;
  files?: { native?: string; check_step?: string; log?: string };
  features_built?: number;
  feature_volumes?: FeatureVolume[];
  error?: { code: string; message?: string; feature?: string; step?: string } | null;
}

function transferError(message: string, code: string, extra: { target?: string; detail?: Record<string, unknown>; hints?: string[] } = {}): PartOpError {
  return new PartOpError(message, { code, ...extra });
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return null; }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** The dispatcher file, or the reason there is none. */
async function readDispatcher(cwd: string): Promise<{ alive: true; file: DispatcherFile } | { alive: false; reason: "absent" | "stale"; file?: DispatcherFile }> {
  const file = await readJson<DispatcherFile>(resolve(cwd, TRANSFER_DIR, "dispatcher.json"));
  if (!file) return { alive: false, reason: "absent" };
  const updated = Date.parse(file.updatedAt ?? "");
  if (!Number.isFinite(updated) || transferHooks.now() - updated > DISPATCHER_STALE_MS) return { alive: false, reason: "stale", file };
  return { alive: true, file };
}

function unavailable(reason: "absent" | "stale"): PartOpError {
  return transferError(
    "cad.transfer needs the Reify desktop app. The desktop app starts Fusion and SolidWorks on the user's computer, and it is not running for this project.",
    "TRANSFER_UNAVAILABLE",
    {
      detail: { dispatcher: reason },
      hints: ["Use cad.transfer.features(...) for a dry run. It does not need the desktop app.", "Ask the user to open the project in the Reify desktop app, or to export a STEP file."],
    },
  );
}

export async function transferStatus(cwd: string): Promise<JsonValue> {
  const dispatcher = await readDispatcher(cwd);
  if (!dispatcher.alive) {
    return jsonValue({ fusion: "unavailable", solidworks: "unavailable", detail: { dispatcher: dispatcher.reason } } as never);
  }
  const targets = dispatcher.file.targets ?? {};
  return jsonValue({
    fusion: targets.fusion ?? "unavailable",
    solidworks: targets.solidworks ?? "unavailable",
    detail: dispatcher.file.detail ?? {},
  } as never);
}

interface WorkerFeatures {
  /** `part` (default) or `assembly` (`reify.assembly/1`). */
  kind?: "part" | "assembly";
  features: { part?: string; bodies?: Array<{ features?: unknown[] }>; reference?: { feature_volumes?: FeatureVolume[] } };
  featureCount: number;
  part: string;
  referenceStep?: string;
  /** Assembly joints. The export carries the pose they solved to, not the joints. */
  joints?: JointSummary[];
}

export interface JointSummary { path: string; type: string; value: number | null }

/** What the user must hear when an assembly with joints goes to a CAD program. */
export function jointNotes(joints: readonly JointSummary[] | undefined): string[] {
  if (!joints?.length) return [];
  const list = joints.map((joint) => `${joint.path} (${joint.type}${joint.value === null ? "" : ` at ${joint.value}`})`).join(", ");
  return [`The exported assembly keeps the pose the joints solved to (${list}). The joints and their limits are not exported: the parts are placed, not jointed. Say so to the user; they must add joints in the CAD program if they want to move the parts.`];
}

function documentPaths(cwd: string, doc: string) {
  return resolvePartPaths(cwd, doc);
}

async function canonicalize(cwd: string, doc: string, referenceStepAbs?: string): Promise<WorkerFeatures> {
  const result = await transferHooks.canonicalize(cwd, doc, referenceStepAbs) as WorkerFeatures;
  if (!result?.features || typeof result.featureCount !== "number") {
    throw transferError("the FreeCAD worker returned no feature JSON", "TRANSFER_EXECUTOR_FAILED", { detail: { doc } });
  }
  return result;
}

async function featuresOperation(cwd: string, request: Extract<TransferRequest, { op: "transfer-features" }>): Promise<JsonValue> {
  const paths = documentPaths(cwd, request.doc);
  const result = await canonicalize(cwd, request.doc);
  const stem = basename(paths.docRel, extname(paths.docRel));
  const kind = result.kind ?? "part";
  const pathRel = projectRelativePath(cwd, join("build", "transfer", `${stem}.${kind === "assembly" ? "assembly" : "features"}.json`));
  await writeJsonAtomic(resolve(cwd, pathRel), result.features);
  const text = JSON.stringify(result.features);
  return jsonValue({
    kind, part: result.part, features: result.featureCount, path: pathRel,
    ...(jointNotes(result.joints).length ? { notes: jointNotes(result.joints), joints: result.joints } : {}),
    ...(Buffer.byteLength(text) <= INLINE_FEATURES_BYTES ? { data: result.features } : {}),
  } as never);
}

function newJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function validateExport(request: Extract<TransferRequest, { op: "transfer-export" }>): { target: Target } {
  if (!TARGETS.includes(request.target as Target)) {
    throw transferError(`target must be "fusion" or "solidworks", got ${JSON.stringify(request.target)}`, "BAD_REQUEST");
  }
  const target = request.target as Target;
  if (request.output !== undefined && (typeof request.output !== "string" || !SUFFIX[target].test(request.output))) {
    throw transferError(`a ${target} export must end in ${target === "fusion" ? ".f3d" : ".SLDPRT or .SLDASM"}`, "BAD_REQUEST", { detail: { output: request.output } });
  }
  return { target };
}

/** The native file name: the caller's, or `exports/<stem>.<ext>`. A part is .SLDPRT, an assembly .SLDASM. */
function resolveOutput(request: Extract<TransferRequest, { op: "transfer-export" }>, target: Target, kind: "part" | "assembly", stem: string): string {
  const extension = target === "fusion" ? ".f3d" : kind === "assembly" ? ".SLDASM" : ".SLDPRT";
  if (request.output === undefined) return join("exports", `${stem}${extension}`);
  if (target === "solidworks" && !request.output.toLowerCase().endsWith(extension.toLowerCase())) {
    throw transferError(`a SolidWorks ${kind} export must end in ${extension}`, "BAD_REQUEST", { detail: { output: request.output } });
  }
  return request.output;
}

/** Executor error code on the spool -> `CadApiError.code` of the Agent API. */
function mapExecutorError(result: SpoolResult, target: Target): PartOpError {
  const error = result.error ?? { code: "EXECUTOR_FAILED" };
  const detail = { target, feature: error.feature ?? null, step: error.step ?? null, ...(result.files?.log ? { log: result.files.log } : {}) };
  const message = error.message || `${target} could not build the part`;
  switch (error.code) {
    case "TARGET_NOT_READY":
      return transferError(message, "TRANSFER_TARGET_NOT_READY", { detail, hints: [SETTINGS_HINT] });
    case "TIMEOUT":
      return transferError(message || `${target} did not finish in time`, "TRANSFER_TIMEOUT", { detail, ...(error.feature ? { target: error.feature } : {}) });
    case "UNSUPPORTED_OP":
      return transferError(message, "TRANSFER_UNSUPPORTED_OP", { detail, ...(error.feature ? { target: error.feature } : {}) });
    default:
      return transferError(message, "TRANSFER_EXECUTOR_FAILED", { detail, ...(error.feature ? { target: error.feature } : {}) });
  }
}

async function waitForResult(cwd: string, jobId: string, timeoutS: number): Promise<SpoolResult> {
  const resultPath = resolve(cwd, TRANSFER_DIR, "results", `${jobId}.json`);
  const deadline = transferHooks.now() + (timeoutS + 60) * 1000;
  let silentSince: number | null = null;
  for (;;) {
    const result = await readJson<SpoolResult>(resultPath);
    if (result) return result;
    const now = transferHooks.now();
    if (now > deadline) {
      await mkdir(resolve(cwd, TRANSFER_DIR, "cancel"), { recursive: true });
      await writeFile(resolve(cwd, TRANSFER_DIR, "cancel", jobId), "", "utf8");
      throw transferError(`the export did not finish in ${timeoutS} s`, "TRANSFER_TIMEOUT", { detail: { jobId } });
    }
    // The desktop app stopped: no heartbeat, and no job in progress.
    const dispatcher = await readDispatcher(cwd);
    if (dispatcher.alive) silentSince = null;
    else {
      silentSince ??= now;
      if (now - silentSince > DISPATCHER_STALE_MS) throw unavailable(dispatcher.reason);
    }
    await transferHooks.sleep(transferHooks.pollMs);
  }
}

async function exportOperation(cwd: string, request: Extract<TransferRequest, { op: "transfer-export" }>): Promise<JsonValue> {
  const { target } = validateExport(request);
  const check = request.check !== false;
  const paths = documentPaths(cwd, request.doc);

  const dispatcher = await readDispatcher(cwd);
  if (!dispatcher.alive) throw unavailable(dispatcher.reason);
  const state = dispatcher.file.targets?.[target] ?? "unavailable";
  if (state !== "ready") {
    throw transferError(`${target} is not ready on this computer (${state}).`, "TRANSFER_TARGET_NOT_READY", {
      detail: { target, state }, hints: [SETTINGS_HINT],
    });
  }

  if (request.jobId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.jobId)) {
    throw transferError("jobId must be 1 to 64 letters, digits, _ or -", "BAD_REQUEST", { detail: { jobId: request.jobId } });
  }
  // The desktop UI picks the id, so its progress events and its cancel button name the same job.
  const jobId = request.jobId ?? newJobId();
  const workRel = join("build", "transfer", jobId);
  const referenceRel = projectRelativePath(cwd, join(workRel, "reference.step"));
  const featuresRel = projectRelativePath(cwd, join(workRel, "features.json"));
  await mkdir(resolve(cwd, workRel), { recursive: true });

  const canonical = await canonicalize(cwd, request.doc, resolve(cwd, referenceRel));
  const kind = canonical.kind ?? "part";
  const outputRel = projectRelativePath(cwd, resolveOutput(request, target, kind, basename(paths.docRel, extname(paths.docRel))));
  await writeJsonAtomic(resolve(cwd, featuresRel), canonical.features);

  const checkStepRel = projectRelativePath(cwd, join(workRel, "check.step"));
  await mkdir(dirname(resolve(cwd, outputRel)), { recursive: true });
  await writeJsonAtomic(resolve(cwd, TRANSFER_DIR, "requests", `${jobId}.json`), {
    schema: "reify.transfer.request/1", jobId, target, doc: paths.docRel, kind,
    ...(kind === "assembly" ? { assembly: featuresRel } : { features: featuresRel }),
    native: outputRel, checkStep: checkStepRel, check, timeoutS: DEFAULT_TIMEOUT_S,
  });

  let result: SpoolResult;
  try {
    result = await waitForResult(cwd, jobId, DEFAULT_TIMEOUT_S);
  } finally {
    // A cancel file must stay: the dispatcher reads it after this module gave up.
    await rm(resolve(cwd, TRANSFER_DIR, "requests", `${jobId}.json`), { force: true });
  }
  await Promise.all(["status", "results"].map((folder) => rm(resolve(cwd, TRANSFER_DIR, folder, `${jobId}.json`), { force: true })));
  if (!result.ok) throw mapExecutorError(result, target);

  const nativeRel = result.files?.native ?? outputRel;
  try { await stat(resolve(cwd, nativeRel)); }
  catch {
    throw transferError(`the executor reported success but ${nativeRel} does not exist`, "TRANSFER_EXECUTOR_FAILED", { detail: { target, file: nativeRel } });
  }
  const logRel = result.files?.log ?? null;
  const features = result.features_built ?? canonical.featureCount;
  const notes = jointNotes(canonical.joints);
  const notesField = notes.length ? { notes } : {};
  // v1 never blocks an export on DFM; the export only states the document's latest DFM state.
  const dfm = await readDfmSummary(cwd, paths.docRel);

  if (!check) {
    return jsonValue({ target, file: nativeRel, checkStep: result.files?.check_step ?? null, check: "skipped", features, log: logRel, detail: null, dfm, ...notesField } as never);
  }

  const executorStepRel = result.files?.check_step ?? checkStepRel;
  const executorStepExists = await stat(resolve(cwd, executorStepRel)).then(() => true, () => false);
  if (!executorStepExists) {
    throw transferError("the executor wrote no verification STEP, so the export cannot be checked", "TRANSFER_CHECK_FAILED", {
      detail: { target, file: nativeRel, checkStep: executorStepRel, log: logRel },
      hints: ["Run the export again. Use check=False only to debug the executor."],
    });
  }
  const [referenceGeometry, executorGeometry] = await Promise.all([
    transferHooks.inspect(cwd, referenceRel, join(workRel, "reference.geometry.json")),
    transferHooks.inspect(cwd, executorStepRel, join(workRel, "check.geometry.json")),
  ]);
  const report = compareEquivalence(referenceGeometry, executorGeometry, {
    reference: canonical.features.reference?.feature_volumes,
    executor: result.feature_volumes,
  });
  if (!report.passed) {
    const first = report.firstDifferingFeature;
    throw transferError(
      `${target} built a different shape: ${report.failures.join("; ")}${first ? `. The first feature that differs is ${first.name}.` : ""}`,
      "TRANSFER_CHECK_FAILED",
      {
        ...(first ? { target: first.name } : {}),
        detail: { target, file: nativeRel, checkStep: executorStepRel, referenceStep: referenceRel, log: logRel, report: report as never },
        hints: ["The files are kept for debugging. Do not give them to the user as a good result."],
      },
    );
  }
  return jsonValue({ target, file: nativeRel, checkStep: executorStepRel, check: "passed", features, log: logRel, detail: null, dfm, ...notesField } as never);
}

export async function handleTransferOperation(cwd: string, request: TransferRequest): Promise<JsonValue> {
  switch (request.op) {
    case "transfer-status": return transferStatus(cwd);
    case "transfer-features": return featuresOperation(cwd, request);
    case "transfer-export": return exportOperation(cwd, request);
  }
}

/** For tests and the desktop app: remove a finished job's spool entries. */
export async function clearSpoolJob(cwd: string, jobId: string): Promise<void> {
  for (const [folder, suffix] of [["requests", ".json"], ["status", ".json"], ["results", ".json"], ["cancel", ""]] as const) {
    await rm(resolve(cwd, TRANSFER_DIR, folder, `${jobId}${suffix}`), { force: true });
  }
}
