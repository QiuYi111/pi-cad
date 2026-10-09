/**
 * Agent API operations of the FreeCAD part backend (`part-*`).
 *
 * Every successful `part-open`, `part-apply` and `part-undo` ends in the same
 * place as a build123d build: the STEP is bound to its identity manifest, then
 * `observeCandidate` checks the geometry, summarises the change, renders the
 * seven mandatory views and registers the evidence. `part-try`, `part-sweep`
 * and the read-only commands never touch run state.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { jsonValue, type JsonValue } from "../harness/canonical.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { recordObservationV7 } from "../harness/observations.ts";
import { resolveActiveRun } from "../harness/run-scope.ts";
import { changedFaces, summarizeBuildChanges, type FeatureChanges } from "../modules/model/build-changes.ts";
import {
  bindIdentity,
  inspectGeometry,
  inspectVisual,
  runGeometryEvidencePath,
  visualPayload,
} from "../shared/capability.ts";
import { PartOpError, runPartCommand } from "../shared/freecad-worker.ts";
import type { FaceFingerprint, GeometryPayload } from "../shared/protocol.ts";
import { sha256File } from "../shared/hash.ts";
import { observeCandidate, projectRelativePath } from "./observe.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";

type PartRequest = Extract<AgentApiRequest, { op: `part-${string}` }>;
type Validation = "auto" | "fast" | "full";

const HISTORY_DIR = ".pi-cad/cache/part-history";
const TRY_DIR = ".pi-cad/cache/part-try";
const DFM_DIR = ".pi-cad/cache/part-dfm";
/** A DFM issue face is the fingerprint whose centroid lies this close to the issue target centre (mm). */
const DFM_FACE_MATCH_MM = 0.05;

export interface PartPaths {
  docRel: string;
  docAbs: string;
  outputRel: string;
  outputAbs: string;
  historyAbs: string;
}

export function resolvePartPaths(cwd: string, doc: string, output?: string): PartPaths {
  if (typeof doc !== "string" || !/\.FCStd$/i.test(doc)) {
    throw new PartOpError("a part document must be a project path ending in .FCStd", { code: "BAD_REQUEST", detail: { doc } });
  }
  const docRel = projectRelativePath(cwd, doc);
  const stem = basename(docRel, extname(docRel));
  const outputRel = projectRelativePath(cwd, output ?? join("build", `${stem}.step`));
  if (!/\.(step|stp)$/i.test(outputRel)) {
    throw new PartOpError("a part output must be a project path ending in .step", { code: "BAD_REQUEST", detail: { output } });
  }
  const key = createHash("sha256").update(docRel).digest("hex").slice(0, 16);
  return {
    docRel,
    docAbs: resolve(cwd, docRel),
    outputRel,
    outputAbs: resolve(cwd, outputRel),
    historyAbs: resolve(cwd, HISTORY_DIR, key),
  };
}

/** Test seam: the identity binder can be replaced to make one binding fail. */
export const partOpsHooks = { bindIdentity, inspectGeometry, inspectVisual };

/** Every worker request carries the arguments that open its document, so a restarted sidecar can reopen it. */
export function partRequest(cwd: string, paths: PartPaths, request: Omit<Parameters<typeof runPartCommand>[1], "doc" | "ensureOpen">, body?: string) {
  return runPartCommand(cwd, {
    ...request,
    doc: paths.docAbs,
    ensureOpen: { output: paths.outputAbs, historyDir: paths.historyAbs, root: resolve(cwd), ...(body ? { body } : {}), create: false },
  });
}

interface WorkerBuildResult {
  rev: number;
  fcstd: string;
  fcstdSha256: string;
  step: string | null;
  declarations: string | null;
  features?: FeatureChanges["features"];
  params?: FeatureChanges["params"];
  intent?: FeatureChanges["intent"];
  warnings?: FeatureChanges["warnings"];
  highlight?: FeatureChanges["highlight"];
  annotations?: Array<{ text: string; at: [number, number, number] }>;
  [key: string]: unknown;
}

async function activeRun(cwd: string) {
  const active = await resolveActiveRun(cwd, mechanicalRegistries);
  if (!active) throw new Error("model.build authorization lost its active workflow");
  return active;
}

/** Bind identity and observe a freshly written STEP; returns the fields shared by open, apply and undo. */
async function observeWorkerResult(cwd: string, paths: PartPaths, result: WorkerBuildResult, validation: Validation) {
  if ("dfm" in result) await recordDfmSummary(cwd, paths.docRel, result.dfm);
  if (!result.step || !result.declarations) {
    return { part: jsonValue(result as never), images: [], changes: null, highlighted: false, artifact: null };
  }
  const bound = await partOpsHooks.bindIdentity(cwd, projectRelativePath(cwd, result.step), projectRelativePath(cwd, result.declarations));
  if (!bound.ok) {
    const payload = bound.payload as { error?: string; paths?: string[] } | undefined;
    throw new PartOpError(payload?.error || "the part could not be bound to semantic names", {
      code: "IDENTITY_BIND_FAILED",
      detail: { paths: payload?.paths ?? [] },
    });
  }
  const active = await activeRun(cwd);
  const observed = await observeCandidate(cwd, active, {
    artifact: paths.outputRel,
    sourcePath: paths.docRel,
    sourceHash: result.fcstdSha256,
    validation,
    backend: "freecad",
    extraChanges: {
      features: result.features, params: result.params, intent: result.intent, warnings: result.warnings, highlight: result.highlight,
    },
    ...(result.annotations?.length ? { annotations: result.annotations } : {}),
  });
  const stepHash = await sha256File(paths.outputAbs);
  const { visual: _visual, geometry: _geometry, ...rest } = observed;
  return {
    part: jsonValue(result as never),
    ...rest,
    artifact: { path: paths.outputRel, sha256: stepHash },
  };
}

/**
 * A failure after the worker committed leaves the document one revision ahead of
 * the registered candidate. Undo it, then bind and register the restored STEP, so
 * the file on disk, the identity manifest and the run state describe one revision.
 */
async function committedStep<T>(cwd: string, paths: PartPaths, validation: Validation, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    let restored: WorkerBuildResult | null = null;
    try {
      // The revision just committed is the one being taken back, even when it was the first one.
      restored = (await partRequest(cwd, paths, { op: "undo", args: { to_empty: true } })) as WorkerBuildResult;
    } catch { /* reported below */ }
    let registered = false;
    if (restored) {
      try {
        await observeWorkerResult(cwd, paths, restored, validation);
        registered = true;
      } catch { /* the document is restored; the STEP is not registered */ }
    }
    const detail = {
      ...(error instanceof PartOpError ? error.detail ?? {} : { freecadStatus: "observation of the committed revision failed" }),
      undone: restored !== null,
      stepRegistered: registered,
      ...(restored !== null && !registered ? { note: `the document is at revision ${restored.rev} but its STEP is not registered; apply again to rebuild it` } : {}),
    };
    const rolledBack = restored !== null && registered;
    const notice = restored !== null
      ? ` [Rolled back: the document is at revision ${restored.rev}; this failed revision was undone automatically. Do NOT call undo again.]`
      : "";
    const hints = [
      ...(error instanceof PartOpError ? error.hints ?? [] : []),
      ...(restored !== null ? [`rolled back: the document is at revision ${restored.rev}; undo is not needed`] : []),
    ];
    const message = `${error instanceof Error ? error.message : String(error)}${notice}`;
    if (error instanceof PartOpError) {
      throw new PartOpError(message, {
        code: error.code,
        ...(error.target !== undefined ? { target: error.target } : {}),
        detail,
        ...(hints.length ? { hints } : {}),
        rolledBack,
      });
    }
    throw new PartOpError(message, { code: "FEATURE_FAILED", detail, ...(hints.length ? { hints } : {}), rolledBack });
  }
}

/** The DFM summary the worker reports with every build result: enough for export to state the geometry state and error count. */
function compactDfm(summary: unknown): Record<string, unknown> | null {
  if (!summary || typeof summary !== "object") return null;
  const { rulepack, material, layer, counts, geometry } = summary as Record<string, unknown>;
  return { rulepack, material, layer, counts, geometry };
}

function dfmSummaryPath(cwd: string, docRel: string): string {
  const key = createHash("sha256").update(docRel).digest("hex").slice(0, 16);
  return resolve(cwd, DFM_DIR, `${key}.json`);
}

export async function recordDfmSummary(cwd: string, docRel: string, summary: unknown): Promise<void> {
  const path = dfmSummaryPath(cwd, docRel);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(compactDfm(summary))}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * The latest DFM state of a document: the summary from its last build, or from its last
 * geometry run (`part-dfm`). Null when the document has no DFM profile, or was never built.
 */
export async function readDfmSummary(cwd: string, docRel: string): Promise<JsonValue | null> {
  try { return JSON.parse(await readFile(dfmSummaryPath(cwd, docRel), "utf8")) as JsonValue; }
  catch { return null; }
}

function budget(request: { budgetS?: number }): { budgetS?: number } {
  return request.budgetS === undefined ? {} : { budgetS: request.budgetS };
}

async function openDocument(cwd: string, request: Extract<PartRequest, { op: "part-open" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const result = (await runPartCommand(cwd, {
    op: "open",
    doc: paths.docAbs,
    args: { output: paths.outputAbs, historyDir: paths.historyAbs, root: resolve(cwd), body: request.body, create: request.create ?? false },
  })) as WorkerBuildResult & { created?: boolean };
  const observed = await observeWorkerResult(cwd, paths, result, request.validation ?? "auto");
  return { ...observed, created: Boolean(result.created) };
}

async function applyOps(cwd: string, request: Extract<PartRequest, { op: "part-apply" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  if (request.observe === false) {
    // A step on the way to a finished assembly: commit the revision and stop. Exporting, inspecting and drawing
    // the whole assembly after each of 80 links costs more than the links; the apply that follows observes.
    const committed = (await partRequest(cwd, paths, {
      op: "apply",
      args: { ops: request.ops, message: request.message, observe: false },
      ...budget(request),
    })) as WorkerBuildResult;
    return { part: jsonValue(committed as never), images: [], changes: null, highlighted: false, artifact: null, observed: false };
  }
  const result = (await partRequest(cwd, paths, {
    op: "apply",
    args: { ops: request.ops, message: request.message },
    ...budget(request),
  })) as WorkerBuildResult;
  return committedStep(cwd, paths, request.validation ?? "auto", () => observeWorkerResult(cwd, paths, result, request.validation ?? "auto"));
}

async function undo(cwd: string, request: Extract<PartRequest, { op: "part-undo" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const result = (await partRequest(cwd, paths, { op: "undo", args: { to_empty: request.toEmpty === true } })) as WorkerBuildResult;
  return observeWorkerResult(cwd, paths, result, request.validation ?? "auto");
}

/** Inspect and render a temporary STEP outside run evidence. Never registers a candidate. */
async function observeTemporary(cwd: string, paths: PartPaths, stepAbs: string, annotations: Array<{ text: string; at: [number, number, number] }>, extra?: FeatureChanges) {
  const stepRel = projectRelativePath(cwd, stepAbs);
  const workDir = dirname(stepAbs);
  const geometryPath = join(workDir, `${basename(stepAbs)}.geometry.json`);
  const geometry = await inspectGeometry(cwd, stepRel, projectRelativePath(cwd, geometryPath));
  if (!geometry.ok) {
    throw new PartOpError(String((geometry.payload as { error?: string } | undefined)?.error ?? "geometry inspection of the trial failed"), { code: "FEATURE_FAILED", detail: { freecadStatus: "inspection failed" } });
  }
  const current = geometry.payload as GeometryPayload;
  const active = await activeRun(cwd);
  let previous: GeometryPayload | null = null;
  try { previous = JSON.parse(await readFile(runGeometryEvidencePath(cwd, active.state.runId, paths.outputRel), "utf8")) as GeometryPayload; } catch { /* no baseline yet */ }
  const changes = summarizeBuildChanges(previous, current, extra);
  const highlight = changedFaces(previous, current);
  const visual = await inspectVisual(cwd, stepRel, projectRelativePath(cwd, join(workDir, "views")), {
    ...(highlight.length ? { highlight } : {}),
    ...(annotations.length ? { annotations } : {}),
  });
  if (!visual.ok) {
    throw new PartOpError(String((visual.payload as { error?: string } | undefined)?.error ?? "rendering of the trial failed"), { code: "FEATURE_FAILED", detail: { freecadStatus: "rendering failed" } });
  }
  const views = visualPayload(visual).views ?? [];
  const images = await Promise.all(views.map(async (view) => ({
    name: view.name,
    data: (await readFile(view.path)).toString("base64"),
    mimeType: "image/png",
  })));
  return { images, changes, highlighted: highlight.length > 0, views, geometry, visual };
}

async function recordObservation(cwd: string, headline: string, facts: Array<{ key: string; value: string }>, views: Array<{ name: string; path: string }>): Promise<string | null> {
  try {
    const active = await resolveActiveRun(cwd, mechanicalRegistries);
    if (!active) return null;
    const visuals = await Promise.all(views.map(async (view) => ({ name: view.name, path: view.path, sha256: await sha256File(view.path) })));
    const recorded = await recordObservationV7({
      cwd, workflowRunId: active.state.runId, registries: mechanicalRegistries, tool: "cad_probe", headline,
      facts, visuals, diagnostics: [], provenance: { tool: "part", source: "freecad" } as never,
    });
    const path = recorded.state.contextRefs?.latestObservation;
    return path ? path.split("/").at(-1)!.replace(/\.json$/, "") : null;
  } catch {
    return null;
  }
}

async function tryOps(cwd: string, request: Extract<PartRequest, { op: "part-try" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const key = createHash("sha256").update(JSON.stringify([paths.docRel, request.ops])).digest("hex").slice(0, 16);
  const directory = resolve(cwd, TRY_DIR, key);
  await mkdir(directory, { recursive: true });
  const stepAbs = join(directory, "trial.step");
  const result = (await partRequest(cwd, paths, {
    op: "try", args: { ops: request.ops, output: stepAbs }, ...budget(request),
  })) as WorkerBuildResult;
  if (!result.step) return { part: jsonValue(result as never), images: [], changes: null, highlighted: false };
  const observed = await observeTemporary(cwd, paths, stepAbs, result.annotations ?? [], {
    features: result.features, params: result.params, intent: result.intent, warnings: result.warnings,
  });
  const observationId = await recordObservation(cwd, `part try (not applied): ${paths.docRel}`, [
    { key: "document", value: paths.docRel },
    { key: "changes", value: JSON.stringify(observed.changes) },
  ], observed.views);
  return { part: jsonValue(result as never), images: observed.images, changes: observed.changes, highlighted: observed.highlighted, ...(observationId ? { observationId } : {}) };
}

/** What the worker's `dfm` command returns (see python/reify_freecad/worker.py cmd_dfm). */
interface WorkerDfmReport {
  rulepack: string;
  material: string;
  rev: number;
  analyzer: string | null;
  counts: Record<string, number>;
  issues: Array<{ severity?: string; target?: unknown; [key: string]: unknown }>;
  coverage: Array<Record<string, unknown>>;
  highlight: unknown;
  annotations: Array<{ text: string; at: [number, number, number] }>;
  report_path: string;
}

/** Distance from a point to the surface of a fingerprinted face, or null when the fingerprint has no surface model. */
function surfaceResidual(face: FaceFingerprint, point: number[]): number | null {
  const offset = [point[0]! - face.c[0], point[1]! - face.c[1], point[2]! - face.c[2]];
  if (face.type === "PLANE" && face.n) {
    const length = Math.hypot(face.n[0]!, face.n[1]!, face.n[2]!) || 1;
    return Math.abs((offset[0]! * face.n[0]! + offset[1]! * face.n[1]! + offset[2]! * face.n[2]!) / length);
  }
  if ((face.type === "CYLINDER" || face.type === "CONE") && face.ax && face.ap && face.r !== undefined) {
    const axis = face.ax;
    const axisLength = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
    const unit = axis.map((value) => value / axisLength);
    const toPoint = [point[0]! - face.ap[0]!, point[1]! - face.ap[1]!, point[2]! - face.ap[2]!];
    const along = toPoint[0]! * unit[0]! + toPoint[1]! * unit[1]! + toPoint[2]! * unit[2]!;
    const perpendicular = [0, 1, 2].map((k) => toPoint[k]! - along * unit[k]!);
    return Math.abs(Math.hypot(perpendicular[0]!, perpendicular[1]!, perpendicular[2]!) - face.r);
  }
  return null;
}

/**
 * The DFM geometry check. Issues that name a face are highlighted on the current STEP, the
 * same way a build highlights its changed faces, and every view is attached: the image is
 * always part of the result.
 */
async function dfmOperation(cwd: string, request: Extract<PartRequest, { op: "part-dfm" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const layers = request.layers;
  const report = (await partRequest(cwd, paths, {
    op: "dfm", args: layers ? { layers } : {}, ...budget(request),
  })) as WorkerDfmReport;
  const reportAbs = resolve(cwd, projectRelativePath(cwd, report.report_path));
  const runDir = dirname(reportAbs);
  const geometryRel = projectRelativePath(cwd, join(runDir, `rev-${report.rev}.geometry.json`));
  const viewsRel = projectRelativePath(cwd, join(runDir, `rev-${report.rev}-views`));

  const geometry = await partOpsHooks.inspectGeometry(cwd, paths.outputRel, geometryRel);
  if (!geometry.ok) {
    throw new PartOpError(String((geometry.payload as { error?: string } | undefined)?.error ?? "geometry inspection for the DFM report failed"), { code: "FEATURE_FAILED", detail: { freecadStatus: "inspection failed" } });
  }
  const faces: FaceFingerprint[] = (geometry.payload as GeometryPayload | undefined)?.faceFingerprints ?? [];
  const annotations = report.annotations ?? [];
  const flagged = new Set<number>();
  for (const issue of report.issues) {
    if (issue.severity !== "error" && issue.severity !== "warn") continue;
    const centre = (issue.target as { centre?: unknown } | null)?.centre;
    if (Array.isArray(centre) && centre.length === 3) {
      // A target with a centre names a face: take the face whose centroid is nearest.
      let best = -1;
      let bestDistance = Infinity;
      faces.forEach((face, index) => {
        const distance = Math.hypot(face.c[0] - Number(centre[0]), face.c[1] - Number(centre[1]), face.c[2] - Number(centre[2]));
        if (distance < bestDistance) { best = index; bestDistance = distance; }
      });
      if (best >= 0 && bestDistance <= DFM_FACE_MATCH_MM) flagged.add(best);
      continue;
    }
    // A feature-path target has no centre: the worker's label for that rule sits on a face of the feature.
    // Every face that the label point lies on (within DFM_FACE_MATCH_MM) is highlighted.
    for (const note of annotations) {
      if (note.text !== issue.rule) continue;
      faces.forEach((face, index) => {
        const residual = surfaceResidual(face, note.at);
        if (residual !== null && residual <= DFM_FACE_MATCH_MM) flagged.add(index);
      });
    }
  }
  const highlight = [...flagged].sort((a, b) => a - b).map((index) => faces[index]!);

  const visual = await partOpsHooks.inspectVisual(cwd, paths.outputRel, viewsRel, {
    ...(highlight.length ? { highlight } : {}),
    ...(annotations.length ? { annotations } : {}),
  });
  if (!visual.ok) {
    throw new PartOpError(String((visual.payload as { error?: string } | undefined)?.error ?? "rendering of the DFM report failed"), { code: "FEATURE_FAILED", detail: { freecadStatus: "rendering failed" } });
  }
  const views = visualPayload(visual).views ?? [];
  const images = await Promise.all(views.map(async (view) => ({
    name: view.name,
    data: (await readFile(view.path)).toString("base64"),
    mimeType: "image/png",
  })));

  const ranGeometry = !layers || layers.includes("geometry");
  if (ranGeometry) {
    await recordDfmSummary(cwd, paths.docRel, {
      rulepack: report.rulepack, material: report.material, layer: "lint+geometry", counts: report.counts,
      geometry: { state: "fresh", last_rev: report.rev },
    });
  }
  const observationId = await recordObservation(cwd, `part DFM check: ${paths.docRel}`, [
    { key: "document", value: paths.docRel },
    { key: "counts", value: JSON.stringify(report.counts) },
    { key: "reportPath", value: projectRelativePath(cwd, reportAbs) },
  ], views);
  return {
    report: { ...report, report_path: projectRelativePath(cwd, reportAbs) } as never,
    images,
    highlighted: highlight.length > 0,
    ...(observationId ? { observationId } : {}),
  };
}

async function sweep(cwd: string, request: Extract<PartRequest, { op: "part-sweep" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const key = createHash("sha256").update(JSON.stringify([paths.docRel, request.param, request.range, request.step, request.check])).digest("hex").slice(0, 16);
  const directory = resolve(cwd, TRY_DIR, `sweep-${key}`);
  await mkdir(directory, { recursive: true });
  const stepAbs = join(directory, "worst-pose.step");
  const result = (await partRequest(cwd, paths, {
    op: "sweep",
    args: { param: request.param, range: request.range, step: request.step, check: request.check, refine: request.refine ?? false, output: stepAbs },
    ...budget(request),
  })) as { pose?: { step: string; annotations: Array<{ text: string; at: [number, number, number] }> }; [key: string]: unknown };
  const { pose, ...summary } = result;
  if (!pose?.step) return { sweep: jsonValue(summary as never), images: [] };
  const observed = await observeTemporary(cwd, paths, stepAbs, pose.annotations ?? []);
  const observationId = await recordObservation(cwd, `part sweep ${request.param} (worst pose)`, [
    { key: "document", value: paths.docRel },
    { key: "worstPose", value: String(summary.worstPose) },
    { key: "min", value: JSON.stringify(summary.min) },
  ], observed.views);
  return { sweep: jsonValue(summary as never), images: observed.images, ...(observationId ? { observationId } : {}) };
}

/**
 * Part operations that change a document and register it as the run's candidate
 * (`part-open`, `part-apply`, `part-undo`) run one at a time per project. The FreeCAD
 * worker is a single process that already runs its commands in order, but an operation
 * is more than one worker command: apply commits, then the STEP is bound, inspected,
 * rendered and registered as the run's one authoritative candidate, and a failure
 * after the commit sends an undo. Interleaving those steps across documents (an agent
 * running `asyncio.gather(doc.apply(...))` over several parts) let one document's
 * observation, rollback or run-state write overlap another document's commit.
 * Reads, trials and sweeps only queue behind the worker.
 */
const projectLocks = new Map<string, Promise<unknown>>();

async function exclusive<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(cwd);
  const previous = projectLocks.get(key) ?? Promise.resolve();
  const turn = previous.then(action, action);
  const tail = turn.then(() => undefined, () => undefined);
  projectLocks.set(key, tail);
  try {
    return await turn;
  } finally {
    if (projectLocks.get(key) === tail) projectLocks.delete(key);
  }
}

export async function handlePartOperation(cwd: string, request: PartRequest): Promise<JsonValue> {
  switch (request.op) {
    case "part-open":
    case "part-apply":
    case "part-undo":
      return exclusive(cwd, () => handleExclusive(cwd, request));
    default:
      return handleExclusive(cwd, request);
  }
}

async function handleExclusive(cwd: string, request: PartRequest): Promise<JsonValue> {
  switch (request.op) {
    case "part-open": return jsonValue(await openDocument(cwd, request) as never);
    case "part-apply": return jsonValue(await applyOps(cwd, request) as never);
    case "part-undo": return jsonValue(await undo(cwd, request) as never);
    case "part-try": return jsonValue(await tryOps(cwd, request) as never);
    case "part-sweep": return jsonValue(await sweep(cwd, request) as never);
    case "part-dfm": return jsonValue(await dfmOperation(cwd, request) as never);
    case "part-tree": {
      const paths = resolvePartPaths(cwd, request.doc, request.output);
      return jsonValue(await partRequest(cwd, paths, { op: "tree" }) as never);
    }
    case "part-query": {
      const paths = resolvePartPaths(cwd, request.doc, request.output);
      return jsonValue(await partRequest(cwd, paths, { op: "query", args: { target: request.target, what: request.what } }) as never);
    }
    case "part-check": {
      const paths = resolvePartPaths(cwd, request.doc, request.output);
      return jsonValue(await partRequest(cwd, paths, { op: "check", args: { kind: request.kind, args: request.args }, ...budget(request) }) as never);
    }
  }
}

