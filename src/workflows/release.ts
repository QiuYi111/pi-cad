import type { WorkflowSpec } from "./types.ts";

export const releaseWorkflow: WorkflowSpec = {
  name: "release",
  nextAfterRequirements: "audit",
  sourcePhases: [],
  candidateReviewPhase: "review",
  planNext: {},
  planStayPhases: ["audit", "gap_closure", "package"],
  transitions: {
    audit: {
      audit_complete: "gap_closure",
      workstreams_structurally_closed: "package",
    },
    gap_closure: {
      engineering_changed: "audit",
      workstreams_structurally_closed: "package",
    },
    package: { package_prepared: "final_review" },
    final_review: {
      artifact_issue: "package",
      engineering_issue: "gap_closure",
      accepted: "ready",
    },
  },
  acceptedPhases: ["final_review"],
  acceptedEvidence: () => ["visual", "geometry"],
  finishEvidence: () => ["visual", "geometry"],
  requiresBaselineInput: false,
  baselineEvidenceRequired: false,
  mutationPolicies: { package: "allowed" },
};
