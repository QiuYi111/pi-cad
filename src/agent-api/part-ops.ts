/**
 * Agent API operations of the FreeCAD part backend (`part-*`).
 *
 * Every successful `part-open`, `part-apply` and `part-undo` ends in the same
 * place as a build123d build: the STEP is bound to its identity manifest, then
 * `observeCandidate` checks the geometry, summarises the change, renders the
 * seven mandatory views and registers the evidence. `part-try`, `part-sweep`
 * and the read-only commands never touch run state.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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
import type { GeometryPayload } from "../shared/protocol.ts";
import { sha256File } from "../shared/store.ts";
import { observeCandidate, projectRelativePath } from "./observe.ts";
import type { AgentApiRequest } from "./protocol.ts";

type PartRequest = Extract<AgentApiRequest, { op: `part-${string}` }>;
type Validation = "auto" | "fast" | "full";

const HISTORY_DIR = ".pi-cad/cache/part-history";
const TRY_DIR = ".pi-cad/cache/part-try";

interface PartPaths {
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
  if (!result.step || !result.declarations) {
    return { part: jsonValue(result as never), images: [], changes: null, highlighted: false, artifact: null };
  }
  const bound = await bindIdentity(cwd, projectRelativePath(cwd, result.step), projectRelativePath(cwd, result.declarations));
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

/** Roll the document back one revision after a failure that came after the commit. */
async function undoAfterFailure(cwd: string, paths: PartPaths): Promise<boolean> {
  try {
    await runPartCommand(cwd, { op: "undo", doc: paths.docAbs });
    return true;
  } catch {
    return false;
  }
}

async function committedStep<T>(cwd: string, paths: PartPaths, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const undone = await undoAfterFailure(cwd, paths);
    if (error instanceof PartOpError) {
      throw new PartOpError(error.message, {
        code: error.code,
        ...(error.target !== undefined ? { target: error.target } : {}),
        detail: { ...(error.detail ?? {}), undone },
        ...(error.hints !== undefined ? { hints: error.hints } : {}),
        rolledBack: undone,
      });
    }
    throw new PartOpError(error instanceof Error ? error.message : String(error), {
      code: "FEATURE_FAILED",
      detail: { freecadStatus: "observation of the committed revision failed", undone },
      rolledBack: undone,
    });
  }
}

function budget(request: { budgetS?: number }): { budgetS?: number } {
  return request.budgetS === undefined ? {} : { budgetS: request.budgetS };
}

async function openDocument(cwd: string, request: Extract<PartRequest, { op: "part-open" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const result = (await runPartCommand(cwd, {
    op: "open",
    doc: paths.docAbs,
    args: { output: paths.outputAbs, historyDir: paths.historyAbs, body: request.body, create: request.create ?? false },
  })) as WorkerBuildResult & { created?: boolean };
  const observed = await observeWorkerResult(cwd, paths, result, request.validation ?? "auto");
  return { ...observed, created: Boolean(result.created) };
}

async function applyOps(cwd: string, request: Extract<PartRequest, { op: "part-apply" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const result = (await runPartCommand(cwd, {
    op: "apply",
    doc: paths.docAbs,
    args: { ops: request.ops, message: request.message },
    ...budget(request),
  })) as WorkerBuildResult;
  return committedStep(cwd, paths, () => observeWorkerResult(cwd, paths, result, request.validation ?? "auto"));
}

async function undo(cwd: string, request: Extract<PartRequest, { op: "part-undo" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const result = (await runPartCommand(cwd, { op: "undo", doc: paths.docAbs })) as WorkerBuildResult;
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
  const result = (await runPartCommand(cwd, {
    op: "try", doc: paths.docAbs, args: { ops: request.ops, output: stepAbs }, ...budget(request),
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

async function sweep(cwd: string, request: Extract<PartRequest, { op: "part-sweep" }>) {
  const paths = resolvePartPaths(cwd, request.doc, request.output);
  const key = createHash("sha256").update(JSON.stringify([paths.docRel, request.param, request.range, request.step, request.check])).digest("hex").slice(0, 16);
  const directory = resolve(cwd, TRY_DIR, `sweep-${key}`);
  await mkdir(directory, { recursive: true });
  const stepAbs = join(directory, "worst-pose.step");
  const result = (await runPartCommand(cwd, {
    op: "sweep",
    doc: paths.docAbs,
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

export async function handlePartOperation(cwd: string, request: PartRequest): Promise<JsonValue> {
  switch (request.op) {
    case "part-open": return jsonValue(await openDocument(cwd, request) as never);
    case "part-apply": return jsonValue(await applyOps(cwd, request) as never);
    case "part-undo": return jsonValue(await undo(cwd, request) as never);
    case "part-try": return jsonValue(await tryOps(cwd, request) as never);
    case "part-sweep": return jsonValue(await sweep(cwd, request) as never);
    case "part-tree": {
      const paths = resolvePartPaths(cwd, request.doc, request.output);
      return jsonValue(await runPartCommand(cwd, { op: "tree", doc: paths.docAbs }) as never);
    }
    case "part-query": {
      const paths = resolvePartPaths(cwd, request.doc, request.output);
      return jsonValue(await runPartCommand(cwd, { op: "query", doc: paths.docAbs, args: { target: request.target, what: request.what } }) as never);
    }
    case "part-check": {
      const paths = resolvePartPaths(cwd, request.doc, request.output);
      return jsonValue(await runPartCommand(cwd, { op: "check", doc: paths.docAbs, args: { kind: request.kind, args: request.args }, ...budget(request) }) as never);
    }
  }
}

