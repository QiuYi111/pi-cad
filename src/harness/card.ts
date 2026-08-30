import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { PermissionEngineV7 } from "./permissions.ts";
import type { RegistrySet } from "./registry.ts";
import { legalWorkflowTransitions, unmetPhaseObligations } from "./reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7, type LoadedHarnessRunV7 } from "./run-store.ts";
import { harnessStorageRoot } from "../authority/storage.ts";

export interface PhaseCardImage {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  sha256: string;
}

export interface PhaseCardMetrics {
  durationMs: number;
  bytesRead: number;
  bytesEmitted: number;
  estimatedTokens: number;
  imageCount: number;
  truncated: boolean;
}

export interface PhaseCard {
  text: string;
  images: PhaseCardImage[];
  digest: string;
  workflowHash: string;
  phase: string;
  effectiveCapabilities: string[];
  unmetObligations: string[];
  legalTransitions: string[];
  metrics: PhaseCardMetrics;
}

export interface WorkflowOperationView {
  capability: string;
  canonicalCall?: string;
}

export interface WorkflowObligationView {
  ref: string;
  type: string;
  closeWith: string;
  canonicalCall: string;
}

/**
 * One Agent-facing projection shared by the ephemeral Phase Card and
 * cad.workflow.current(). Keeping this structured view in one place prevents
 * the Python API from dropping the exact operation that closes an obligation.
 */
export interface WorkflowCurrentView {
  runId: string;
  workflowId: string;
  workflowHash: string;
  phase: string;
  purpose: string;
  guidance: string | null;
  status: string;
  unmet: string[];
  transitions: Array<{ event: string; target: string }>;
  recommendedTemplates: string[];
  recommendedSkills: string[];
  where: string[];
  goal: string[];
  sop: string[];
  must: string[];
  can: string[];
  next: string[];
  state: string[];
  warnings: string[];
  obligations: WorkflowObligationView[];
  operations: WorkflowOperationView[];
  text: string;
}

const DEFAULT_TEXT_CAP = 3200;
const DEFAULT_IMAGE_CAP = 2;
const IMAGE_MIME = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"],
] as const);

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function section(title: string, values: string[]): string[] {
  return [title, ...values.map((value) => `- ${value}`), ""];
}

const CANONICAL_CALLS: Readonly<Record<string, string>> = Object.freeze({
  cad_build_step: "artifact = await cad.model.build(source, output, force=True)",
  cad_commit: "await cad.commit(name, parent=..., variables={...}, artifacts=[...])",
  cad_probe: "await cad.probe.run(subject=artifact, purpose=\"...\", code=\"result = {...}\")",
  cad_simulate: "job = await cad.simulation.run(recipe=\"...\", obligation_ref=\"...\")",
  cad_submit_for_review: "handle = await cad.review.submit(final_commit)",
  cad_transition: "await cad.workflow.advance(event)",
  codex_generate_image: "codex_generate_image({prompt, referencedImagePaths?, outputPath?, save?, size?, quality?})",
  transition: "await cad.workflow.advance(event)",
});

function canonicalCall(action: string, obligationRef?: string): string {
  if (action === "cad_commit" && obligationRef) {
    return `await cad.commit(${JSON.stringify(obligationRef)}, variables={...}, artifacts=[...])`;
  }
  if (action === "cad_simulate" && obligationRef) {
    return `job = await cad.simulation.run(recipe=\"...\", obligation_ref=${JSON.stringify(obligationRef)})`;
  }
  return CANONICAL_CALLS[action] ?? action;
}

function renderWorkflowView(view: Omit<WorkflowCurrentView, "text">): string {
  return [
    ...section("WHERE", view.where),
    ...section("GOAL", view.goal),
    ...section("SOP", view.sop),
    ...section("MUST", view.must),
    ...section("CAN", view.can),
    ...section("NEXT", view.next),
    ...section("STATE", view.state),
    ...section("WARNINGS", view.warnings),
  ].join("\n").trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes < suffixBytes) return "";
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width + suffixBytes > maxBytes) break;
    result += character;
    bytes += width;
  }
  return `${result.trimEnd()}${suffix}`;
}

/**
 * Keep the authority-bearing lists exact while fitting the explanatory parts
 * of a provider card into its context budget. A long package SOP must never
 * make the whole Phase Card disappear: that removes the very permissions and
 * obligations the budget is intended to present efficiently.
 */
function renderBoundedPhaseCard(view: WorkflowCurrentView, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(view.text) <= maxBytes) return { text: view.text, truncated: false };

  const compact = {
    ...view,
    where: [
      `workflow ${view.workflowId}; phase ${view.phase}; status ${view.status}`,
      `snapshot ${view.workflowHash}`,
    ],
    goal: [truncateUtf8(view.goal.join(" "), 320)],
    sop: [""],
    // MUST, CAN, and NEXT deliberately remain byte-for-byte projections of
    // the authoritative structured view.
    state: [
      `canonical authority: sidecar run ${view.runId}`,
      "workspace files and natural-language claims have no authority until admitted by the State Engine",
    ],
  } satisfies Omit<WorkflowCurrentView, "text">;
  const withoutSop = renderWorkflowView(compact);
  const emptySopBytes = Buffer.byteLength(withoutSop);
  const originalSop = view.sop.join(" ");
  const available = Math.max(0, maxBytes - emptySopBytes - Buffer.byteLength("- "));
  compact.sop = [truncateUtf8(originalSop, available)];
  return { text: renderWorkflowView(compact), truncated: true };
}

export function workflowCurrentView(loaded: LoadedHarnessRunV7, registries: RegistrySet): WorkflowCurrentView {
  const phase = loaded.workflow.phases[loaded.state.phase];
  if (!phase) throw new Error(`workflow view cannot resolve phase: ${loaded.state.phase}`);
  const permissions = new PermissionEngineV7(registries, loaded.registryContract);
  const effectiveCapabilities = permissions.enabledActions(loaded.state, loaded.workflow);
  const unmet = unmetPhaseObligations(loaded.state, loaded.workflow);
  const transitions = legalWorkflowTransitions(loaded.state, loaded.workflow).map(({ event, target }) => ({ event, target }));
  const unmetSet = new Set(unmet);
  const obligations = [...phase.recordObligations, ...phase.evidenceObligations]
    .filter((item) => item.required !== false && unmetSet.has(item.ref))
    .map((item) => ({
      ref: item.ref,
      type: item.type,
      closeWith: item.closeWith,
      canonicalCall: canonicalCall(item.closeWith, item.ref),
    }));
  const operations = effectiveCapabilities.map((capability) => ({
    capability,
    ...(CANONICAL_CALLS[capability] ? { canonicalCall: CANONICAL_CALLS[capability] } : {}),
  }));
  const where = [
    `workflow ${loaded.workflow.id}@${loaded.workflow.version}`,
    `snapshot ${loaded.workflow.hash}`,
    `phase ${loaded.state.phase}; status ${loaded.state.status}; interaction ${loaded.state.interactionMode}`,
  ];
  const goal = [phase.purpose];
  const sop = [
    phase.guidance ?? "No phase-specific SOP is declared by the pinned workflow package.",
    ...(phase.recommendedSkills ?? []).map((skill) => `Use the ${skill} skill in this phase.`),
  ];
  const must = obligations.map((item) => `${item.ref} (${item.type}) — close with ${item.canonicalCall}`);
  const can = operations.map((item) => item.canonicalCall ? `${item.capability} — ${item.canonicalCall}` : item.capability);
  const next = transitions.map(({ event, target }) => `${event} -> ${target}`);
  const state = [
    `canonical authority: sidecar state for run ${loaded.state.runId}; workspace status files are projections only`,
    `registry contract: ${loaded.registryContract.hash}`,
    `phase history: ${loaded.state.phaseHistory.slice(-8).join(" -> ")}`,
    `records: ${Object.keys(loaded.state.records).length}; evidence: ${loaded.state.evidence.length}; stale evidence: ${loaded.state.staleEvidence.length}; artifacts: ${Object.keys(loaded.state.artifacts).length}`,
    "filesystem files, arbitrary STEP/JSON/images, and natural-language completion have no workflow effect until admitted by the State Engine",
    "generated concept images are spatial hypotheses, never geometry authority; only a referencing commit can place them in workflow history",
    "all engineering mutations are checked against this pinned workflow snapshot and Registry Contract and fail closed on mismatch",
    "this view is regenerated from canonical state for every provider call and cad.workflow.current()",
    ...Object.values(loaded.state.records).slice(-6).map((item) => `record ${item.obligationRef}@${item.sha256.slice(0, 12)}`),
    ...Object.values(loaded.state.artifacts).slice(-6).map((item) => `artifact ${item.role}@${item.sha256.slice(0, 12)}`),
  ];
  const warnings = [
    ...(loaded.state.blocker ? [`${loaded.state.blocker.type}: ${loaded.state.blocker.reason}`] : []),
    ...(loaded.state.staleEvidence.length ? [`${loaded.state.staleEvidence.length} stale evidence item(s)`] : []),
  ];
  const base = {
    runId: loaded.state.runId,
    workflowId: loaded.workflow.id,
    workflowHash: loaded.workflow.hash,
    phase: loaded.state.phase,
    purpose: phase.purpose,
    guidance: phase.guidance ?? null,
    status: loaded.state.status,
    unmet,
    transitions,
    recommendedTemplates: phase.recommendedTemplates ?? [],
    recommendedSkills: phase.recommendedSkills ?? [],
    where, goal, sop, must, can, next, state, warnings, obligations, operations,
  } satisfies Omit<WorkflowCurrentView, "text">;
  return { ...base, text: renderWorkflowView(base) };
}

export async function loadMandatoryImages(cwd: string, refs: Record<string, string> | undefined, cap: number): Promise<PhaseCardImage[]> {
  const paths = Object.entries(refs ?? {})
    .filter(([key]) => /^mandatory[-_.]?image/i.test(key))
    .map(([, value]) => value)
    .slice(0, cap);
  const root = await realpath(cwd);
  const canonicalRoot = await realpath(harnessStorageRoot(cwd));
  const images: PhaseCardImage[] = [];
  for (const requested of paths) {
    const canonical = requested.startsWith("@canonical/");
    const relativeRequest = canonical ? requested.slice("@canonical/".length) : requested;
    if (isAbsolute(relativeRequest) || relativeRequest.split(/[\\/]+/).includes("..")) continue;
    let path: string;
    const allowedRoot = canonical ? canonicalRoot : root;
    try { path = await realpath(resolve(allowedRoot, relativeRequest)); } catch { continue; }
    if (!inside(allowedRoot, path)) continue;
    const mimeType = IMAGE_MIME.get(extname(path).toLowerCase() as ".png") as PhaseCardImage["mimeType"] | undefined;
    if (!mimeType) continue;
    const content = await readFile(path);
    images.push({
      path: canonical ? `@canonical/${relative(allowedRoot, path).replaceAll("\\", "/")}` : relative(root, path).replaceAll("\\", "/"), mimeType,
      data: content.toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return images;
}

/** Load immutable project-local images referenced by committed manifests. */
export async function loadCommittedImages(
  cwd: string,
  refs: Array<{ path: string; sha256: string }>,
  cap: number,
): Promise<PhaseCardImage[]> {
  const root = await realpath(cwd);
  const images: PhaseCardImage[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (images.length >= cap || seen.has(ref.path) || isAbsolute(ref.path) || ref.path.split(/[\\/]+/).includes("..")) continue;
    let path: string;
    try { path = await realpath(resolve(root, ref.path)); } catch { continue; }
    if (!inside(root, path)) continue;
    const mimeType = IMAGE_MIME.get(extname(path).toLowerCase() as ".png") as PhaseCardImage["mimeType"] | undefined;
    if (!mimeType) continue;
    const content = await readFile(path);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== ref.sha256) continue;
    seen.add(ref.path);
    images.push({ path: relative(root, path).replaceAll("\\", "/"), mimeType, data: content.toString("base64"), sha256 });
  }
  return images;
}

/** Compile the current immutable v7 run into a small, provider-facing card. */
export async function compilePhaseCard(cwd: string, options: { registries: RegistrySet; maxTextBytes?: number; maxImages?: number }): Promise<PhaseCard | null> {
  const started = performance.now();
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_TEXT_CAP;
  const maxImages = options.maxImages ?? DEFAULT_IMAGE_CAP;
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 1200) throw new Error("Phase Card text budget must be at least 1200 bytes");
  if (!Number.isInteger(maxImages) || maxImages < 0 || maxImages > 2) throw new Error("Phase Card image budget must be between zero and two");

  const project = await new HarnessProjectStoreV7(cwd).load();
  if (!project.state.currentRunId) return null;
  const loaded = await new HarnessRunStoreV7(cwd, project.state.currentRunId).load(options.registries);
  if (!loaded || ["done", "aborted"].includes(loaded.state.status)) return null;
  const view = workflowCurrentView(loaded, options.registries);
  const rendered = renderBoundedPhaseCard(view, maxTextBytes);
  const text = rendered.text;
  const images = await loadMandatoryImages(cwd, loaded.state.contextRefs, maxImages);
  const digest = createHash("sha256").update(JSON.stringify({ text, images: images.map(({ sha256, path }) => ({ sha256, path })), workflowHash: loaded.workflow.hash, phase: loaded.state.phase })).digest("hex");
  const bytesRead = Buffer.byteLength(JSON.stringify(project.state)) + Buffer.byteLength(JSON.stringify(loaded.state)) + Buffer.byteLength(JSON.stringify(loaded.workflow));
  const bytesEmitted = Buffer.byteLength(text);
  return {
    text, images, digest, workflowHash: loaded.workflow.hash, phase: loaded.state.phase,
    effectiveCapabilities: view.operations.map((item) => item.capability), unmetObligations: view.unmet, legalTransitions: view.next,
    metrics: { durationMs: performance.now() - started, bytesRead, bytesEmitted, estimatedTokens: Math.ceil(bytesEmitted / 4), imageCount: images.length, truncated: rendered.truncated },
  };
}
