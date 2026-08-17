import type { WorkflowSpec } from "./types.ts";

export const convertWorkflow: WorkflowSpec = {
  name: "convert",
  nextAfterRequirements: "source_baseline",
  sourcePhases: ["convert"],
  candidateReviewPhase: "compare",
  planNext: { transform_plan: "convert" },
  planStayPhases: [],
  transitions: {
    source_baseline: { baseline_understood: "transform_plan" },
    compare: { repair: "convert", accepted: "ready" },
  },
  acceptedPhases: ["compare"],
  acceptedEvidence: (state) =>
    /\.(step|stp)$/i.test(state.currentArtifactPath ?? "")
      ? ["visual", "geometry", "compare"]
      : ["convert"],
  finishEvidence: (state) =>
    /\.(step|stp)$/i.test(state.currentArtifactPath ?? "")
      ? ["visual", "geometry", "compare"]
      : ["convert"],
  requiresBaselineInput: true,
  baselineEvidenceRequired: true,
};
