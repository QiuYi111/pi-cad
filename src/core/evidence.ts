import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { obligationsOf, type CadEventEnvelope, type CadRunState, type EvidenceRef } from "../shared/protocol.ts";
import { sha256File } from "../shared/store.ts";
import {
  addEvidence,
  evidenceFromEnvelope,
  markEvidenceStale,
} from "./state-machine.ts";

export { addEvidence, evidenceFromEnvelope, markEvidenceStale };
export { unmetSimulationCases } from "./evidence-cases.ts";

export const EVIDENCE_KINDS: EvidenceRef["kind"][] = [
  "visual",
  "geometry",
  "surfaces",
  "build",
  "compare",
  "section",
  "drawing",
  "simulation",
  "presentation",
  "convert",
  "assembly",
  "interference",
  "sections",
  "optimization",
];

export async function verifyEvidenceFilesForHash(
  cwd: string,
  state: CadRunState,
  hash: string,
  kinds: EvidenceRef["kind"][],
): Promise<string | null> {
  for (const kind of kinds) {
    const refs = state.evidence.filter(
      (ref) => ref.kind === kind && ref.artifactHash === hash,
    );
    if (refs.length === 0) return `${kind} evidence is missing`;
    if (refs.some((ref) => ref.paths.some((path) => !existsSync(resolve(cwd, path))))) {
      return `${kind} evidence files are missing`;
    }
    for (const ref of refs) {
      if (!ref.artifacts || ref.artifacts.length === 0) {
        return `${kind} evidence has no hashed artifact provenance`;
      }
      for (const artifact of ref.artifacts) {
        if (!existsSync(resolve(cwd, artifact.path))) {
          return `${kind} evidence artifact is missing: ${artifact.path}`;
        }
        if ((await sha256File(resolve(cwd, artifact.path))) !== artifact.sha256) {
          return `${kind} evidence artifact hash changed: ${artifact.path}`;
        }
      }
      // Hash-bound inputs (canonical spec, fluid domain, product artifact)
      // must also still match: evidence must never outlive a rewritten input
      // the harness does not otherwise track.
      for (const input of ref.inputArtifacts ?? []) {
        if (!existsSync(resolve(cwd, input.path))) {
          return `${kind} evidence input is missing: ${input.role} (${input.path})`;
        }
        if ((await sha256File(resolve(cwd, input.path))) !== input.sha256) {
          return `${kind} evidence input hash changed: ${input.role} (${input.path})`;
        }
      }
    }
  }
  return null;
}

export async function verifyCurrentArtifacts(
  cwd: string,
  state: CadRunState,
): Promise<string | null> {
  if (state.route?.objective === "analyze") {
    if (!state.baselineArtifactPath) return "baseline artifact path is not bound";
    const baseline = resolve(cwd, state.baselineArtifactPath);
    if (!existsSync(baseline)) return `baseline artifact is missing: ${state.baselineArtifactPath}`;
    if (state.baselineArtifactHash && (await sha256File(baseline)) !== state.baselineArtifactHash) {
      return "baseline artifact hash does not match the bound version";
    }
    return null;
  }
  if (!state.currentSourcePath || !state.currentArtifactPath) {
    return "current source/artifact paths are not bound";
  }
  const sourceAbs = resolve(cwd, state.currentSourcePath);
  const artifactAbs = resolve(cwd, state.currentArtifactPath);
  if (!existsSync(sourceAbs)) return `current source is missing: ${state.currentSourcePath}`;
  if (!existsSync(artifactAbs)) return `current artifact is missing: ${state.currentArtifactPath}`;
  if (state.currentSourceHash && (await sha256File(sourceAbs)) !== state.currentSourceHash) {
    return "current source hash does not match the bound version";
  }
  if (state.currentArtifactHash && (await sha256File(artifactAbs)) !== state.currentArtifactHash) {
    return "current artifact hash does not match the bound version";
  }
  return null;
}

export function recordToolEvidence(
  state: CadRunState,
  envelope: CadEventEnvelope,
  kind: EvidenceRef["kind"],
  artifactHash: string,
  specHash?: string,
  caseId?: string,
): CadRunState {
  let next = { ...state };
  // Spec-driven evidence (simulation load cases, optimization runs) is
  // identified by kind + artifactHash + specHash, so distinct load cases on
  // the same artifact coexist and re-running one case replaces only itself.
  // Case-scoped simulation evidence is identified by caseId instead, so
  // re-running the same case with changed conditions replaces the stale
  // observation rather than accumulating beside it.
  // Evidence without a spec identity stays latest-wins per kind+artifact.
  next.evidence = next.evidence.filter(
    (ref) =>
      !(
        ref.kind === kind &&
        ref.artifactHash === artifactHash &&
        (caseId !== undefined
          ? // Case identity matches obligation identity exactly:
            // (artifact, tool, caseId). Two obligations that share a case id
            // but declare different tools must never evict each other.
            ref.caseId === caseId && ref.tool === envelope.tool
          : specHash === undefined || ref.specHash === specHash)
      ),
  );
  return addEvidence(
    next,
    evidenceFromEnvelope(kind, envelope.tool, envelope, artifactHash, state.currentSourceHash, specHash, caseId),
  );
}

/**
 * Release presentation deliverables (0.8 M4b): for maturity=release routes,
 * current-version presentation evidence must carry a render manifest that
 * declares the required deliverables — exploded + turntable always, the
 * assembly animation for assembly structure. The manifest and every output
 * it names are hash-verified by verifyEvidenceFilesForHash; this check
 * only reads the declared deliverable set.
 */
export async function verifyPresentationDeliverables(
  cwd: string,
  state: CadRunState,
): Promise<string | null> {
  const route = state.route;
  if (route?.objective !== "design" || route.maturity !== "release") return null;
  // Single source of truth: the required deliverables DERIVE from
  // obligationsOf(route)'s presentation:* keys (part: hero + turntable;
  // assembly adds exploded + assembly_animation).
  const DELIVERABLE_FOR: Record<string, string> = {
    "presentation:hero": "hero.png",
    "presentation:exploded": "exploded.png",
    "presentation:turntable": "turntable.mp4",
    "presentation:assembly_animation": "assembly.mp4",
  };
  const required = [...obligationsOf(route)]
    .filter((key) => key.startsWith("presentation:"))
    .map((key) => DELIVERABLE_FOR[key])
    .filter((name): name is string => Boolean(name));
  if (required.length === 0) return null;
  const refs = state.evidence.filter(
    (ref) =>
      ref.kind === "presentation" &&
      ref.artifactHash === state.currentArtifactHash &&
      !state.staleEvidence.includes(ref),
  );
  if (refs.length === 0) {
    // No presentation evidence at all: report the missing deliverables —
    // the compiled evidence kinds separately enforce presence at accept,
    // and this check must not silently pass without any evidence.
    return `release presentation deliverables missing (no presentation evidence for the current artifact; required: ${required.join(", ")})`;
  }
  for (const ref of refs) {
    const manifestPath = ref.paths.find((path) => path.endsWith("manifest.json"));
    if (!manifestPath) continue;
    try {
      const manifest = JSON.parse(await readFile(resolve(cwd, manifestPath), "utf-8")) as {
        status?: string;
        outputs?: Record<string, unknown>;
      };
      if (manifest.status !== "rendered") continue;
      const outputs = manifest.outputs ?? {};
      const missing = required.filter((name) => !(name in outputs));
      if (missing.length === 0) return null;
    } catch {
      // unreadable manifest: keep looking at other presentation evidence
    }
  }
  return `release presentation deliverables missing from current evidence (required: ${required.join(", ")})`;
}
