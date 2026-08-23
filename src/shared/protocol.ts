/**
 * Pi-CAD wire, state, and workflow types.
 *
 * The state describes process and evidence only.  It never contains
 * engineering semantics ("this is a motor mount", "the design is safe").
 */

import type { Route } from "./route.ts";
import {
  ACTIVE_CAPABILITY_TOOLS,
  ACTIVE_CONTROL_TOOLS,
  ACTIVE_PROBE_TOOLS,
  ACTIVE_SIMULATION_TOOLS,
} from "./public-tools.ts";

export type { Route } from "./route.ts";
export {
  isRoute,
  routeKey,
  routeLabel,
  obligationsOf,
  recordObligations,
  MATURITIES,
  MATURITY_RANK,
  RELEASE_WORKSTREAMS,
} from "./route.ts";
export type {
  RouteObjective,
  RouteLineage,
  RouteStructure,
  CadMaturity,
  ObligationKey,
} from "./route.ts";

export const CAD_STATE_SCHEMA_VERSION = 6;
export const CONTROL_TOOLS = ACTIVE_CONTROL_TOOLS;
export const CAPABILITY_TOOLS = ACTIVE_CAPABILITY_TOOLS;

/**
 * Spec-driven solver tools that produce simulation evidence. They are never
 * part of the source-phase capability set: a source phase builds geometry,
 * and simulations belong to review/cognitive phases against a committed
 * candidate or baseline.
 */
export const SIMULATION_TOOLS = ACTIVE_SIMULATION_TOOLS;

/**
 * Canonical read-only observation tool. Individual presets decide whether an
 * Observation is eligible to bind evidence; programmable probes remain
 * observation-only.
 */
export const PROBE_TOOLS = ACTIVE_PROBE_TOOLS;

/** Tools whose evidence obligations are case-scoped (opaque simulation cases). */
export const SIMULATION_CASE_TOOLS = SIMULATION_TOOLS;

export type CadPhase =
  | "intake"
  | "requirements"
  | "build"
  | "review"
  | "ready"
  | "done"
  | "baseline"
  | "investigate"
  | "explain"
  | "plan"
  | "modify"
  | "concept"
  | "domain_analysis"
  | "source_baseline"
  | "transform_plan"
  | "convert"
  | "compare"
  | "audit"
  | "gap_closure"
  | "package"
  | "final_review"
  // 0.8 structure fragment phases
  | "system_concept"
  | "assembly_design"
  | "interface_design"
  | "part_design"
  | "integration_review";

/** Every phase, in a stable order (phase matrices and contracts iterate this). */
export const CAD_PHASES: readonly CadPhase[] = [
  "intake",
  "requirements",
  "build",
  "review",
  "ready",
  "done",
  "baseline",
  "investigate",
  "explain",
  "plan",
  "modify",
  "concept",
  "domain_analysis",
  "source_baseline",
  "transform_plan",
  "convert",
  "compare",
  "audit",
  "gap_closure",
  "package",
  "final_review",
  "system_concept",
  "assembly_design",
  "interface_design",
  "part_design",
  "integration_review",
] as const;
export type InteractionMode = "interactive" | "headless";
export type CadStatus =
  | "active"
  | "waiting_user"
  | "ready"
  | "done"
  | "aborted"
  | "blocked_user"
  | "blocked_external"
  | "budget_exhausted";
export type MutationPolicy = "read_only" | "source_only" | "allowed";

export interface DeferredClarification {
  phase: CadPhase;
  question: string;
  reason: string;
  alternatives: string[];
  fallback: string;
  impact: string;
  affectsContract: boolean;
  createdAt: string;
}

export interface EvidenceInputArtifact {
  path: string;
  sha256: string;
  /** Provenance role, e.g. spec | artifact | fluidDomain. Opaque to the harness. */
  role: string;
  /** File hash by default; Simulation V2 declared paths use its tree identity. */
  hashKind?: "sha256-file" | "simulation-tree-v1";
}

export interface EvidenceRef {
  id: string;
  kind:
    | "visual"
    | "geometry"
    | "surfaces"
    | "build"
    | "compare"
    | "section"
    | "drawing"
    | "simulation"
    | "presentation"
    | "convert"
    | "assembly"
    | "interference"
    | "sections"
    | "optimization";
  tool: string;
  /**
   * The design this evidence belongs to (the subject artifact — normally the
   * current candidate). This field has always carried that meaning; it is
   * mirrored by subjectArtifactHash, which names the role explicitly, while
   * inputArtifacts[] lists everything the invocation consumed.
   */
  artifactHash: string;
  /** Explicit alias of artifactHash: which design this evidence is about. */
  subjectArtifactHash?: string;
  sourceHash?: string;
  /** Spec identity for spec-driven evidence (simulation load cases, optimization runs). */
  specHash?: string;
  /** Opaque simulation case this evidence satisfies, when the obligation declared one. */
  caseId?: string;
  paths: string[];
  artifacts: Array<{ path: string; sha256: string }>;
  /**
   * Hash-bound inputs (canonical spec, product artifact, fluid domain, ...)
   * re-verified at accept/finish. Without this, a flow result could silently
   * outlive a rewritten fluid-domain STEP that the harness never tracks.
   */
  inputArtifacts?: EvidenceInputArtifact[];
  /** Explicit Simulation V2 identity and immutable provenance binding. */
  simulationRunId?: string;
  observationId?: string;
  computeIdentity?: string;
  provenanceManifestPath?: string;
  provenanceManifestHash?: string;
  createdAt: string;
}

export interface CadRequirements {
  goal: string;
  evidenceObligations?: EvidenceObligations;
  deliverables: string[];
  must: string[];
  /**
   * Pre-registered verification intent. Assertions are committed before the
   * candidate exists and must cover every Must exactly once (M1, M2, ...).
   * They describe what to establish, never candidate-specific selectors or
   * probe programs.
   */
  assertions: AcceptanceAssertion[];
  preferences: string[];
  assumptions: string[];
  openUnknowns: string[];
  /**
   * High-impact questions that would have been asked interactively, but were
   * resolved with an explicit fallback so a headless run could continue.
   */
  deferredClarifications?: Array<{
    question: string;
    reason: string;
    alternatives: string[];
    fallback: string;
    impact: string;
  }>;
  /** Artifacts supplied by the user and bound by the baseline auto-action. */
  inputs?: string[];
}

export interface RequirementsArrayDiff {
  added: string[];
  removed: string[];
  orderChanged: boolean;
  before?: string[];
  after?: string[];
}

export interface RequirementsRevisionDiff {
  arrays: Partial<Record<
    "deliverables" | "must" | "preferences" | "assumptions" | "openUnknowns" | "inputs",
    RequirementsArrayDiff
  >>;
  assertions: {
    added: string[];
    removed: string[];
    changed: string[];
    orderChanged: boolean;
    before?: string[];
    after?: string[];
  };
  fields: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface RequirementsRevisionState {
  previousVersion: string;
  currentVersion: string;
  supersedesVersion: string;
  reason: string;
  routeAssessment: "unchanged" | "changed";
  routeAssessmentReason: string;
  diff: RequirementsRevisionDiff;
  at: string;
}

export type CanonicalAssertionField =
  | "bbox.x"
  | "bbox.y"
  | "bbox.z"
  | "volume"
  | "surfaceArea"
  | "solidCount"
  | "occurrenceCount"
  | "cylinderCount";

export type AssertionExpectation =
  | { kind: "exact"; value: number; unit?: string; tolerance?: number }
  | { kind: "range"; min?: number; max?: number; unit?: string }
  | { kind: "boolean"; expected: boolean }
  | { kind: "relation"; description: string };

export interface AcceptanceAssertion {
  id: string;
  /** Stable 1-based reference into CadRequirements.must, e.g. M1. */
  mustRef: string;
  statement: string;
  binding: {
    subject: string;
    quantity: string;
    reference?: string;
    direction?: string;
  };
  expectation: AssertionExpectation;
  /** Opt-in only: the harness never infers this mapping from prose. */
  canonicalCheck?: { field: CanonicalAssertionField };
}

export interface AcceptanceContract {
  requirementsHash: string;
  assertionsHash: string;
  assertions: AcceptanceAssertion[];
}

export type FinalReviewVerdict = "pass" | "fail" | "unresolved";
export type AssertionReviewVerdict = FinalReviewVerdict | "binding_suspect";

export interface FinalReviewResult {
  verdict: FinalReviewVerdict;
  assertionChecks: Array<{
    assertionId: string;
    verdict: AssertionReviewVerdict;
    finding: string;
    evidenceRefs: string[];
  }>;
  semanticObjections: Array<{
    mustRef: string;
    type: "contradiction" | "missing_evidence" | "binding_suspect" | "semantic_gap";
    finding: string;
    evidenceRefs: string[];
    suggestedProbe?: string;
  }>;
  summary: string;
}

export interface FinalReviewRef {
  path: string;
  sha256: string;
  /** Source identity used to group naturally repeated independent reviews. */
  sourceHash?: string;
  artifactHash: string;
  requirementsHash: string;
  assertionsHash: string;
  evidenceSnapshotHash: string;
  /** This report's independent vote before history aggregation. */
  individualVerdict?: FinalReviewVerdict;
  verdict: FinalReviewVerdict;
  reviewerModel: string;
  reviewerPromptVersion: string;
  createdAt: string;
}

export type EvidenceDisposition =
  | "required"
  | "optional"
  | "not_applicable"
  | "blocked_external";

/**
 * Opaque simulation case: the harness only knows that this interpreter
 * invocation must exist for the current artifact version. Domain semantics
 * remain opaque to the workflow core.
 */
export interface SimulationCaseObligation {
  id: string;
  tool: (typeof SIMULATION_CASE_TOOLS)[number];
}

export interface EvidenceObligations {
  simulation?: {
    disposition: EvidenceDisposition;
    rationale?: string;
    /**
     * Case-scoped obligations. When present, "required" means every listed
     * case must have current simulation evidence from the declared tool;
     * when absent, any current simulation evidence satisfies the obligation.
     */
    cases?: SimulationCaseObligation[];
  };
}

export interface CadPlan {
  summary: string;
  protected: string[];
  plannedChanges: string[];
  interfaces: Array<Record<string, unknown>>;
  datums: string[];
  reviewPlan: string[];
  evidenceObligations?: EvidenceObligations;
  architecture?: string[];
  selectionRationale?: string;
  workstreams?: Array<{ name: string; status: "open" | "complete" | "not_applicable" | "blocked_external" }>;
}

export interface CadRunState {
  schemaVersion: number;
  runId: string;
  projectId: string;
  createdAt: string;
  /** Persisted execution semantics; environment variables only bootstrap this value. */
  interactionMode?: InteractionMode;
  /** Route ontology: objective × lineage × structure × maturity (0.8). */
  route: Route | null;
  phase: CadPhase;
  status: CadStatus;
  mutationPolicy: MutationPolicy;

  /**
   * Current requirements-version phase records (e.g. "assembly_design",
   * "interface_contracts"). A requirements revision invalidates dependent
   * records before record guards and reroute evaluate them again.
   */
  phaseRecords?: string[];

  /**
   * A reroute the Agent requested but could not perform autonomously
   * (it would drop obligations). Recorded so the harness can issue a
   * one-time authority token after a real user turn answers the pause.
   */
  pendingReroute?: { route: Route; reason: string } | null;
  /**
   * One-time downgrade authority, issued by the harness ONLY when the user
   * runs /cad-approve-reroute. Consumed on use; never set from Agent input.
   */
  rerouteAuthorityToken?: string | null;
  /**
   * Route key the authority token was issued for: the token cannot
   * authorize a different reroute than the one the user approved.
   */
  rerouteAuthorityRoute?: string | null;

  /** True after requirements changed the task shape and before cad_reroute. */
  routeRequiresReassessment?: boolean;
  /** Durable current revision metadata; also repairs a missing journal append. */
  lastRequirementsRevision?: RequirementsRevisionState;

  requirementsVersion?: string;
  assertionsVersion?: string;
  planVersion?: string;
  candidateLabel?: string;
  currentSourcePath?: string;
  currentSourceHash?: string;
  currentArtifactPath?: string;
  currentArtifactHash?: string;
  baselineSourcePath?: string;
  baselineSourceHash?: string;
  baselineArtifactPath?: string;
  baselineArtifactHash?: string;

  evidence: EvidenceRef[];
  staleEvidence: EvidenceRef[];
  activeWorkstreams: string[];
  evidenceObligations?: EvidenceObligations;
  /** Run-wide clarification debt, including issues discovered after requirements. */
  deferredClarifications?: DeferredClarification[];
  blocker?: {
    type: "user_authority" | "external_input";
    reason: string;
    needed: string;
    createdAt: string;
  };
  /** Latest review transaction; validity is hash-bound and checked on use. */
  finalReview?: FinalReviewRef;
  workstreamStatuses?: Record<
    string,
    "open" | "complete" | "not_applicable" | "blocked_external"
  >;
  updatedAt: string;
}

export interface CadProjectHead {
  sourcePath?: string;
  sourceHash?: string;
  artifactPath?: string;
  artifactHash?: string;
  evidence: EvidenceRef[];
  updatedAt: string;
}

/**
 * Long-lived design project state. The head says what the design currently
 * is; runs/ say what the Agent has done to it.
 */
export interface CadProjectState {
  schemaVersion: number;
  projectId: string;
  head: CadProjectHead;
  currentRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CadEventEnvelope {
  ok: boolean;
  tool: string;
  toolVersion: string;
  backendVersion?: string;
  inputHashes: Record<string, string>;
  /** Hash-bound inputs with paths+roles, carried into EvidenceRef provenance. */
  inputArtifacts?: EvidenceInputArtifact[];
  outputHashes: Record<string, string>;
  durationMs: number;
  warnings: string[];
  artifacts: Array<{ path: string; kind: string; sha256: string }>;
  payload: Record<string, unknown>;
}

export interface BuildPayload {
  step?: string;
  sidecars?: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface VisualPayload {
  views?: Array<{
    name: string;
    path: string;
    camera: Record<string, number[]>;
    width: number;
    height: number;
  }>;
  units?: string;
  bbox?: number[];
  occurrenceCount?: number;
  solidCount?: number;
  error?: string;
}

export interface GeometryPayload {
  units?: string;
  bbox?: { x: number; y: number; z: number };
  volume?: number;
  surfaceArea?: number;
  solidCount?: number;
  occurrenceCount?: number;
  cylinders?: Array<Record<string, unknown>>;
  planes?: Array<Record<string, unknown>>;
  error?: string;
}

export interface MeasurePayload {
  units?: string;
  metric?: string;
  a?: string;
  b?: string | null;
  value?: unknown;
  detail?: Record<string, unknown>;
  error?: string;
}
