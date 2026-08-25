import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { PermissionEngineV7, renderLegalNextActionLines } from "./permissions.ts";
import type { RegistrySet } from "./registry.ts";
import { unmetPhaseObligations } from "./reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "./run-store.ts";
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

async function mandatoryImages(cwd: string, refs: Record<string, string> | undefined, cap: number): Promise<PhaseCardImage[]> {
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
  const phase = loaded.workflow.phases[loaded.state.phase];
  if (!phase) throw new Error(`Phase Card cannot resolve phase: ${loaded.state.phase}`);

  const permissions = new PermissionEngineV7(options.registries, loaded.registryContract);
  const effectiveCapabilities = permissions.enabledActions(loaded.state, loaded.workflow);
  const unmetObligations = unmetPhaseObligations(loaded.state, loaded.workflow);
  const legalTransitions = Object.entries(phase.transitions).map(([event, transition]) => `${event} -> ${transition.target}`);
  const state = [
    `canonical authority: sidecar state for run ${loaded.state.runId}; workspace status files are projections only`,
    `registry contract: ${loaded.registryContract.hash}`,
    `phase history: ${loaded.state.phaseHistory.slice(-8).join(" -> ")}`,
    `records: ${Object.keys(loaded.state.records).length}; evidence: ${loaded.state.evidence.length}; stale evidence: ${loaded.state.staleEvidence.length}; artifacts: ${Object.keys(loaded.state.artifacts).length}`,
    "filesystem files, arbitrary STEP/JSON/images, and natural-language completion have no workflow effect until admitted by the State Engine",
    "generated concept images are spatial hypotheses, never geometry authority; only a referencing commit can place them in workflow history",
    "all engineering mutations are checked against this pinned workflow snapshot and Registry Contract and fail closed on mismatch",
    "this card is regenerated from canonical state for every provider call, replaces the prior ephemeral card, and is never copied into permanent trajectory history",
    ...Object.values(loaded.state.records).slice(-6).map((item) => `record ${item.obligationRef}@${item.sha256.slice(0, 12)}`),
    ...Object.values(loaded.state.artifacts).slice(-6).map((item) => `artifact ${item.role}@${item.sha256.slice(0, 12)}`),
  ];
  const warnings = [
    ...(loaded.state.blocker ? [`${loaded.state.blocker.type}: ${loaded.state.blocker.reason}`] : []),
    ...(loaded.state.staleEvidence.length ? [`${loaded.state.staleEvidence.length} stale evidence item(s)`] : []),
  ];
  const renderedNext = renderLegalNextActionLines(legalTransitions).map((line) => line.slice(2));
  const lines = [
    ...section("WHERE", [
      `workflow ${loaded.workflow.id}@${loaded.workflow.version}`,
      `snapshot ${loaded.workflow.hash}`,
      `phase ${loaded.state.phase}; status ${loaded.state.status}; interaction ${loaded.state.interactionMode}`,
    ]),
    ...section("GOAL", [phase.purpose]),
    ...section("SOP", [phase.guidance ?? "No phase-specific SOP is declared by the pinned workflow package."]),
    ...section("MUST", unmetObligations),
    ...section("CAN", effectiveCapabilities),
    ...section("NEXT", renderedNext),
    ...section("STATE", state),
    ...section("WARNINGS", warnings),
  ];
  const text = lines.join("\n").trim();
  if (Buffer.byteLength(text) > maxTextBytes) {
    throw new Error(`Phase Card authoritative sections exceed the ${maxTextBytes}-byte budget`);
  }
  const images = await mandatoryImages(cwd, loaded.state.contextRefs, maxImages);
  const digest = createHash("sha256").update(JSON.stringify({ text, images: images.map(({ sha256, path }) => ({ sha256, path })), workflowHash: loaded.workflow.hash, phase: loaded.state.phase })).digest("hex");
  const bytesRead = Buffer.byteLength(JSON.stringify(project.state)) + Buffer.byteLength(JSON.stringify(loaded.state)) + Buffer.byteLength(JSON.stringify(loaded.workflow));
  const bytesEmitted = Buffer.byteLength(text);
  return {
    text, images, digest, workflowHash: loaded.workflow.hash, phase: loaded.state.phase,
    effectiveCapabilities, unmetObligations, legalTransitions,
    metrics: { durationMs: performance.now() - started, bytesRead, bytesEmitted, estimatedTokens: Math.ceil(bytesEmitted / 4), imageCount: images.length, truncated: false },
  };
}
