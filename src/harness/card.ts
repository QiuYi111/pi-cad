import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { unmetPhaseObligations } from "./reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "./run-store.ts";

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
  metrics: PhaseCardMetrics;
}

const DEFAULT_TEXT_CAP = 6 * 1024;
const DEFAULT_IMAGE_CAP = 2;
const IMAGE_MIME = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"],
] as const);

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function boundedLines(title: string, values: string[], limit = 8): string[] {
  if (!values.length) return [];
  const shown = values.slice(0, limit).map((value) => `- ${value}`);
  if (values.length > limit) shown.push(`- … ${values.length - limit} more`);
  return [title, ...shown, ""];
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const content = Buffer.from(text, "utf-8");
  if (content.length <= maxBytes) return { text, truncated: false };
  const marker = "\n\nWarnings\n- Phase Card truncated to its hard text budget.";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  return { text: `${content.subarray(0, budget).toString("utf-8").replace(/\uFFFD+$/, "").trimEnd()}${marker}`, truncated: true };
}

async function mandatoryImages(cwd: string, refs: Record<string, string> | undefined, cap: number): Promise<PhaseCardImage[]> {
  const paths = Object.entries(refs ?? {})
    .filter(([key]) => /^mandatory[-_.]?image/i.test(key))
    .map(([, value]) => value)
    .slice(0, cap);
  const root = await realpath(cwd);
  const images: PhaseCardImage[] = [];
  for (const requested of paths) {
    if (isAbsolute(requested) || requested.split(/[\\/]+/).includes("..")) continue;
    let path: string;
    try { path = await realpath(resolve(root, requested)); } catch { continue; }
    if (!inside(root, path)) continue;
    const mimeType = IMAGE_MIME.get(extname(path).toLowerCase() as ".png") as PhaseCardImage["mimeType"] | undefined;
    if (!mimeType) continue;
    const content = await readFile(path);
    images.push({
      path: relative(root, path).replaceAll("\\", "/"), mimeType,
      data: content.toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return images;
}

/** Compile the current immutable v7 run into a small, provider-facing card. */
export async function compilePhaseCard(cwd: string, options: { maxTextBytes?: number; maxImages?: number } = {}): Promise<PhaseCard | null> {
  const started = performance.now();
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_TEXT_CAP;
  const maxImages = options.maxImages ?? DEFAULT_IMAGE_CAP;
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 256) throw new Error("Phase Card text budget must be at least 256 bytes");
  if (!Number.isInteger(maxImages) || maxImages < 0 || maxImages > 8) throw new Error("Phase Card image budget is invalid");

  const project = await new HarnessProjectStoreV7(cwd).load();
  if (!project.state.currentRunId) return null;
  const loaded = await new HarnessRunStoreV7(cwd, project.state.currentRunId).load();
  if (!loaded || ["done", "aborted"].includes(loaded.state.status)) return null;
  const phase = loaded.workflow.phases[loaded.state.phase];
  if (!phase) throw new Error(`Phase Card cannot resolve phase: ${loaded.state.phase}`);

  const current = [
    ...Object.values(loaded.state.records).map((item) => `commit/record: ${item.obligationRef}@${item.sha256.slice(0, 12)}`),
    ...Object.values(loaded.state.artifacts).map((item) => `artifact: ${item.role}@${item.sha256.slice(0, 12)}`),
  ];
  if (!current.length) current.push("no committed phase state yet");
  const expected = unmetPhaseObligations(loaded.state, loaded.workflow).map((ref) => `commit/evidence: ${ref}`);
  if (phase.reviewProfile) expected.push(`independent review: ${phase.reviewProfile}`);
  expected.push(...Object.entries(phase.transitions).map(([event, transition]) => `transition: ${event} → ${transition.target}`));
  const recommended = [
    ...(phase.recommendedTemplates ?? []).map((name) => `template: ${name}`),
    ...(phase.recommendedSkills ?? []).map((name) => `skill: ${name}`),
  ];
  const warnings = [
    ...(loaded.state.blocker ? [`${loaded.state.blocker.type}: ${loaded.state.blocker.reason}`] : []),
    ...(loaded.state.staleEvidence.length ? [`${loaded.state.staleEvidence.length} stale evidence item(s)`] : []),
  ];
  const lines = [
    "[Pi-CAD]", "", "Phase", `${loaded.state.phase.toUpperCase()} — ${phase.purpose}`, "",
    ...(phase.guidance ? ["SOP", phase.guidance, ""] : []),
    ...boundedLines("Current", current),
    ...boundedLines("Expected", expected),
    ...boundedLines("Recommended", recommended),
    ...boundedLines("Warnings", warnings),
  ];
  const bounded = truncateUtf8(lines.join("\n").trim(), maxTextBytes);
  const images = await mandatoryImages(cwd, loaded.state.contextRefs, maxImages);
  const digest = createHash("sha256").update(JSON.stringify({ text: bounded.text, images: images.map(({ sha256, path }) => ({ sha256, path })), workflowHash: loaded.workflow.hash, phase: loaded.state.phase })).digest("hex");
  const bytesRead = Buffer.byteLength(JSON.stringify(project.state)) + Buffer.byteLength(JSON.stringify(loaded.state)) + Buffer.byteLength(JSON.stringify(loaded.workflow));
  const bytesEmitted = Buffer.byteLength(bounded.text);
  return {
    text: bounded.text, images, digest, workflowHash: loaded.workflow.hash, phase: loaded.state.phase,
    metrics: { durationMs: performance.now() - started, bytesRead, bytesEmitted, estimatedTokens: Math.ceil(bytesEmitted / 4), imageCount: images.length, truncated: bounded.truncated },
  };
}
