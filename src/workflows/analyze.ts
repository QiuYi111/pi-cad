import type { WorkflowSpec } from "./types.ts";

export const analyzeWorkflow: WorkflowSpec = {
  name: "analyze",
  nextAfterRequirements: "baseline",
  sourcePhases: [],
  candidateReviewPhase: "review",
  planNext: {},
  planStayPhases: [],
  transitions: {
    baseline: { baseline_understood: "investigate" },
    investigate: { more_probe: "investigate", cause_understood: "explain" },
    explain: { findings_delivered: "ready" },
  },
  acceptedPhases: [],
  acceptedEvidence: () => ["visual", "geometry"],
  finishEvidence: () => ["visual", "geometry"],
  requiresBaselineInput: true,
  baselineEvidenceRequired: true,
};
