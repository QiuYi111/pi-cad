import type {
  CadPhase,
  CadRunState,
  EvidenceRef,
  MutationPolicy,
} from "../shared/protocol.ts";

export type EvidenceKindsResolver = (state: CadRunState) => EvidenceRef["kind"][];

export interface WorkflowSpec {
  /** Phase entered when requirements are committed. */
  nextAfterRequirements: CadPhase;
  /** Phases from which cad_commit_candidate is accepted. */
  sourcePhases: CadPhase[];
  /**
   * Review phase a committed candidate lands in, for source phases without
   * a more specific entry in sourcePhaseReviews (e.g. build → review,
   * gap_closure → audit).
   */
  candidateReviewPhase: CadPhase;
  /**
   * Per-source-phase review targets. Release processes have two loops:
   * design sources land in the design review, gap_closure lands in audit.
   */
  sourcePhaseReviews?: Partial<Record<CadPhase, CadPhase>>;
  /** Phases where cad_commit_plan moves to a new phase. */
  planNext: Partial<Record<CadPhase, CadPhase>>;
  /** Phases where cad_commit_plan stays in place (e.g. release audit). */
  planStayPhases: CadPhase[];
  /**
   * Explicit transition table. The "accepted" event's target here is
   * authoritative: "ready" closes the run, any other phase (e.g. "audit"
   * when a release suffix follows the design core) continues the process.
   */
  transitions: Partial<Record<CadPhase, Record<string, CadPhase>>>;
  /** Phases where event "accepted" has procedural evidence guards. */
  acceptedPhases: CadPhase[];
  /** Evidence kinds required for accepted in review/compare phases. */
  acceptedEvidence: EvidenceKindsResolver;
  /** Evidence kinds required by cad_finish. */
  finishEvidence: EvidenceKindsResolver;
  /** Whether requirements must bind a baseline artifact. */
  requiresBaselineInput: boolean;
  /** Whether leaving baseline requires visual + geometry evidence. */
  baselineEvidenceRequired: boolean;
  /** Mutation policy overrides (defaults are derived from phase type). */
  mutationPolicies?: Partial<Record<CadPhase, MutationPolicy>>;
  /**
   * Optional process-specific completion guard. The generic engine calls it
   * on accepted/finish and only understands a non-null error string.
   */
  completionGuard?: (state: CadRunState) => string | null;
  /** True when accepted candidate should become the new Project Head. */
  updatesHeadOnAccept?: boolean;
  /**
   * Records staled by ENTERING a phase: review regressions invalidate the
   * downstream record trail so it cannot be reused to skip re-committing.
   */
  recordStaleOnEnter?: Partial<Record<CadPhase, string[]>>;
}
