import type {
  CadPhase,
  CadProjectState,
  CadWorkflow,
  EvidenceRef,
  MutationPolicy,
} from "../shared/protocol.ts";

export type EvidenceKindsResolver = (state: CadProjectState) => EvidenceRef["kind"][];

export interface WorkflowSpec {
  name: CadWorkflow;
  /** Phase entered when requirements are committed. */
  nextAfterRequirements: CadPhase;
  /** Phases from which cad_commit_candidate is accepted. */
  sourcePhases: CadPhase[];
  /** Phase entered after a successful candidate commit. */
  candidateReviewPhase: CadPhase;
  /** Phases where cad_commit_plan moves to a new phase. */
  planNext: Partial<Record<CadPhase, CadPhase>>;
  /** Phases where cad_commit_plan stays in place (e.g. release audit). */
  planStayPhases: CadPhase[];
  /** Explicit transition table. */
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
   * Optional workflow-specific completion guard. The generic engine calls it
   * on accepted/finish and only understands a non-null error string.
   */
  completionGuard?: (state: CadProjectState) => string | null;
}
