import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { CadProjectState } from "../shared/protocol.ts";

const PROMPT_DIR = new URL("../prompts/", import.meta.url);
const promptCache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached !== undefined) return cached;
  try {
    const path = fileURLToPath(new URL(`${name}.md`, PROMPT_DIR));
    const text = await readFile(path, "utf-8");
    promptCache.set(name, text);
    return text;
  } catch {
    const fallback = `# Pi-CAD ${name}\n\nCurrent workflow phase: ${name}. Use cad_* control tools to continue.\n`;
    promptCache.set(name, fallback);
    return fallback;
  }
}

export function stateSummary(state: CadProjectState): string {
  const lines = [
    `workflow=${state.workflow ?? "unset"} phase=${state.phase} status=${state.status}`,
    `mutationPolicy=${state.mutationPolicy}`,
    `maturity=${state.maturity}`,
  ];
  if (state.candidateLabel) lines.push(`candidate=${state.candidateLabel}`);
  if (state.currentSourceHash) lines.push(`currentSourceHash=${state.currentSourceHash.slice(0, 12)}`);
  if (state.currentArtifactHash) lines.push(`currentArtifactHash=${state.currentArtifactHash.slice(0, 12)}`);
  if (state.baselineArtifactHash) lines.push(`baselineArtifactHash=${state.baselineArtifactHash.slice(0, 12)}`);
  lines.push(`currentEvidence=${state.evidence.map((e) => e.kind).join(",") || "none"}`);
  if (state.staleEvidence.length) lines.push(`staleEvidence=${state.staleEvidence.length}`);
  if (state.workflow === "release") {
    lines.push(
      `workstreams=${Object.entries(state.workstreamStatuses ?? {})
        .map(([k, v]) => `${k}:${v}`)
        .join(",") || "unset"}`,
    );
  }
  return lines.join("\n");
}

export async function composeSystemPrompt(
  base: string,
  state: CadProjectState | null,
  unavailableCapabilities: string[] = [],
): Promise<string> {
  const invariants = await loadPrompt("invariants");
  if (!state) {
    const unavailable =
      unavailableCapabilities.length > 0
        ? `\n\n## Unavailable optional capabilities\n${unavailableCapabilities.join(", ")} — tools are not loaded. Treat their evidence states as unavailable; do not claim completion.`
        : "";
    return `${base}\n\n${invariants}${unavailable}`;
  }
  const phasePrompt = await loadPrompt(state.phase);
  const statusNote =
    state.status === "waiting_user"
      ? "\n\n## Waiting for user\nA cad_wait_for_user decision is outstanding. The new user turn resolves it; do not re-ask the same question if it was just answered."
      : "";
  const unavailable =
    unavailableCapabilities.length > 0
      ? `\n\n## Unavailable optional capabilities\n${unavailableCapabilities.join(", ")} — report their workstream status as blocked_external or not_applicable, never as complete.`
      : "";
  return [
    base,
    invariants,
    phasePrompt,
    "## Current canonical state (authoritative)",
    stateSummary(state),
    "Use cad_* control tools to move the workflow. Do not claim completion without the corresponding state and evidence.",
    statusNote,
    unavailable,
  ].join("\n\n");
}
