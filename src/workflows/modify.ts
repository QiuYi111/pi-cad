import type { WorkflowSpec } from "./types.ts";

export const modifyWorkflow: WorkflowSpec = {
  name: "modify",
  nextAfterRequirements: "baseline",
  sourcePhases: ["modify"],
  candidateReviewPhase: "review",
  planNext: { plan: "modify" },
  planStayPhases: [],
  transitions: {
    baseline: { baseline_understood: "plan" },
    review: {
      revise: "modify",
      local_geometry_issue: "modify",
      intent_issue: "plan",
      architecture_issue: "plan",
      accepted: "ready",
    },
  },
  acceptedPhases: ["review"],
  acceptedEvidence: () => ["visual", "geometry", "compare"],
  finishEvidence: () => ["visual", "geometry", "compare"],
  requiresBaselineInput: true,
  baselineEvidenceRequired: true,
  updatesHeadOnAccept: true,
};
