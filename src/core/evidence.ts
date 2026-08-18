import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CadEventEnvelope, CadRunState, EvidenceRef } from "../shared/protocol.ts";
import { sha256File } from "../shared/store.ts";
import {
  addEvidence,
  evidenceFromEnvelope,
  markEvidenceStale,
} from "./state-machine.ts";

export { addEvidence, evidenceFromEnvelope, markEvidenceStale };

export const EVIDENCE_KINDS: EvidenceRef["kind"][] = [
  "visual",
  "geometry",
  "build",
  "compare",
  "section",
  "drawing",
  "simulation",
  "presentation",
  "convert",
  "assembly",
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
    }
  }
  return null;
}

export async function verifyCurrentArtifacts(
  cwd: string,
  state: CadRunState,
): Promise<string | null> {
  if (state.workflow === "analyze") {
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
): CadRunState {
  let next = { ...state };
  // Spec-driven evidence (simulation load cases, optimization runs) is
  // identified by kind + artifactHash + specHash, so distinct load cases on
  // the same artifact coexist and re-running one case replaces only itself.
  // Evidence without a spec identity stays latest-wins per kind+artifact.
  next.evidence = next.evidence.filter(
    (ref) =>
      !(
        ref.kind === kind &&
        ref.artifactHash === artifactHash &&
        (specHash === undefined || ref.specHash === specHash)
      ),
  );
  return addEvidence(
    next,
    evidenceFromEnvelope(kind, envelope.tool, envelope, artifactHash, state.currentSourceHash, specHash),
  );
}
