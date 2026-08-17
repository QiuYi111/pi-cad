import type { WorkflowSpec } from "./types.ts";

export const hybridWorkflow: WorkflowSpec = {
  name: "hybrid",
  nextAfterRequirements: "baseline",
  sourcePhases: ["build"],
  candidateReviewPhase: "review",
  planNext: { intent: "build" },
  planStayPhases: [],
  transitions: {
    baseline: { baseline_understood: "concept" },
    concept: {
      domain_work_needed: "domain_analysis",
      explore_more: "concept",
      direction_selected: "intent",
    },
    domain_analysis: { domain_question_answered: "concept" },
    intent: { plan_committed: "build" },
    review: {
      revise: "build",
      local_geometry_issue: "build",
      interface_or_detail_issue: "intent",
      architecture_issue: "concept",
      accepted: "ready",
    },
  },
  acceptedPhases: ["review"],
  acceptedEvidence: () => ["visual", "geometry"],
  finishEvidence: () => ["visual", "geometry"],
  requiresBaselineInput: true,
  baselineEvidenceRequired: true,
  updatesHeadOnAccept: true,
};
