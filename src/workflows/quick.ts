import type { WorkflowSpec } from "./types.ts";

export const quickWorkflow: WorkflowSpec = {
  name: "quick",
  nextAfterRequirements: "build",
  sourcePhases: ["build"],
  candidateReviewPhase: "review",
  planNext: {},
  planStayPhases: [],
  transitions: {
    review: {
      revise: "build",
      local_geometry_issue: "build",
      intent_issue: "build",
      architecture_issue: "build",
      accepted: "ready",
    },
  },
  acceptedPhases: ["review"],
  acceptedEvidence: () => ["visual", "geometry"],
  finishEvidence: () => ["visual", "geometry"],
  requiresBaselineInput: false,
  baselineEvidenceRequired: false,
  updatesHeadOnAccept: true,
};
