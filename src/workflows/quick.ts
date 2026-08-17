/**
 * Backward-compatible exports for the V0 Quick workflow.
 *
 * The implementation is now the full workflow registry in ./registry.ts;
 * V0 is simply the "quick" workflow with its transition subset.
 */
import type { CadEventEnvelope, CadProjectState, EvidenceRef } from "../shared/protocol.ts";
import {
  acceptCandidate,
  addEvidence,
  commitPlan,
  commitRequirements,
  createIntakeState,
  evidenceForArtifact,
  evidenceFromBuild,
  evidenceFromEnvelope,
  finish as finishQuick,
  hasCurrentEvidence,
  hasEvidenceForArtifact,
  markEvidenceStale,
  mutationPolicyForPhase,
  releaseWorkstreamsClosed,
  resumeFromUser,
  route as routeQuick,
  toolsForPhase,
  transition as transitionQuick,
  transitionTarget,
  waitForUser,
} from "./registry.ts";

function evidenceFromVisual(
  envelope: CadEventEnvelope,
  artifactHash: string,
  sourceHash: string,
): EvidenceRef {
  return evidenceFromEnvelope("visual", "cad_inspect_visual", envelope, artifactHash, sourceHash);
}

function evidenceFromGeometry(
  envelope: CadEventEnvelope,
  artifactHash: string,
  sourceHash: string,
): EvidenceRef {
  return evidenceFromEnvelope("geometry", "cad_inspect_geometry", envelope, artifactHash, sourceHash);
}

export {
  acceptCandidate,
  addEvidence,
  commitPlan,
  commitRequirements,
  createIntakeState,
  evidenceForArtifact,
  evidenceFromBuild,
  evidenceFromGeometry,
  evidenceFromVisual,
  finishQuick,
  hasCurrentEvidence,
  hasEvidenceForArtifact,
  markEvidenceStale,
  mutationPolicyForPhase,
  releaseWorkstreamsClosed,
  resumeFromUser,
  routeQuick,
  toolsForPhase,
  transitionQuick,
  transitionTarget,
  waitForUser,
};
