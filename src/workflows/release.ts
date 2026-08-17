import type { CadRunState } from "../shared/protocol.ts";
import type { WorkflowSpec } from "./types.ts";

const RELEASE_WORKSTREAMS = [
  "design_definition",
  "manufacturing_definition",
  "bom",
  "assembly_service",
  "inspection_acceptance",
  "engineering_analysis",
  "risk_quality",
  "configuration",
  "presentation",
] as const;

export function releaseCompletionGuard(state: CadRunState): string | null {
  for (const name of RELEASE_WORKSTREAMS) {
    const value = state.workstreamStatuses?.[name];
    if (!value || value === "open") {
      return `release workstream ${name} has no non-open status`;
    }
  }
  return null;
}

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
  updatesHeadOnAccept: false,
  completionGuard: releaseCompletionGuard,
};
