import type { WorkflowSpec } from "./types.ts";

export const greenfieldWorkflow: WorkflowSpec = {
  name: "greenfield",
  nextAfterRequirements: "concept",
  sourcePhases: ["build"],
  candidateReviewPhase: "review",
  planNext: { intent: "build" },
  planStayPhases: [],
  transitions: {
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
  requiresBaselineInput: false,
  baselineEvidenceRequired: false,
};
