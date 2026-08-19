import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { CadProjectState, CadRunState } from "../shared/protocol.ts";
import { routeKey } from "../shared/protocol.ts";

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

export function stateSummary(state: CadRunState): string {
  const lines = [
    `route=${state.route ? routeKey(state.route) : "unset"} phase=${state.phase} status=${state.status}`,
    `mutationPolicy=${state.mutationPolicy}`,
  ];
  if (state.candidateLabel) lines.push(`candidate=${state.candidateLabel}`);
  if (state.currentSourceHash) lines.push(`currentSourceHash=${state.currentSourceHash.slice(0, 12)}`);
  if (state.currentArtifactHash) lines.push(`currentArtifactHash=${state.currentArtifactHash.slice(0, 12)}`);
  if (state.baselineArtifactHash) lines.push(`baselineArtifactHash=${state.baselineArtifactHash.slice(0, 12)}`);
  lines.push(`currentEvidence=${state.evidence.map((e) => e.kind).join(",") || "none"}`);
  if (state.staleEvidence.length) lines.push(`staleEvidence=${state.staleEvidence.length}`);
  if (state.phaseRecords?.length) lines.push(`phaseRecords=${state.phaseRecords.join(",")}`);
  if (state.pendingReroute) lines.push(`pendingReroute=${routeKey(state.pendingReroute.route)}`);
  if (state.rerouteAuthorityToken) lines.push(`rerouteAuthorityToken=${state.rerouteAuthorityToken} (one-time)`);
  if (state.route?.objective === "design" && state.route.maturity === "release") {
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
  state: CadRunState | null,
  unavailableCapabilities: string[] = [],
  project: CadProjectState | null = null,
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
  const projectHead = project?.head
    ? [
        "## Current design head (the design, not the workflow)",
        `project=${project.projectId}`,
        project.head.sourcePath ? `source=${project.head.sourcePath}@${project.head.sourceHash?.slice(0, 12)}` : "",
        project.head.artifactPath ? `artifact=${project.head.artifactPath}@${project.head.artifactHash?.slice(0, 12)}` : "",
        `headEvidence=${project.head.evidence.map((e) => e.kind).join(",") || "none"}`,
        "Use this as the current design input when starting a new workflow run. Do not carry over phase/status from previous runs.",
      ].filter(Boolean).join("\n")
    : "";
  return [
    base,
    invariants,
    phasePrompt,
    "## Current canonical state (authoritative)",
    stateSummary(state),
    "Use cad_* control tools to move the workflow. Do not claim completion without the corresponding state and evidence.",
    statusNote,
    projectHead,
    unavailable,
  ].join("\n\n");
}
