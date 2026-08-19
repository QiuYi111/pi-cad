/**
 * Pi-CAD wire, state, and workflow types.
 *
 * The state describes process and evidence only.  It never contains
 * engineering semantics ("this is a motor mount", "the design is safe").
 */

import type { Route } from "./route.ts";

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

export const CAD_STATE_SCHEMA_VERSION = 4;
export const CONTROL_TOOLS = [
  "cad_route",
  "cad_reroute",
  "cad_commit_requirements",
  "cad_commit_frame_context",
  "cad_commit_plan",
  "cad_commit_assembly_design",
  "cad_commit_interface_contracts",
  "cad_commit_candidate",
  "cad_transition",
  "cad_wait_for_user",
  "cad_finish",
] as const;
export const CAPABILITY_TOOLS = [
  "cad_build_step",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_surfaces",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_inspect_interference",
  "cad_scan_sections",
  "cad_export",
  "cad_simulate",
  "cad_simulate_flow",
  "cad_simulate_thermal",
  "cad_optimize",
  "cad_generate_drawing",
  "cad_render_scene",
] as const;

/**
 * Spec-driven solver tools that produce simulation evidence. They are never
 * part of the source-phase capability set: a source phase builds geometry,
 * and simulations belong to review/cognitive phases against a committed
 * candidate or baseline.
 */
export const SIMULATION_TOOLS = [
  "cad_simulate",
  "cad_simulate_flow",
  "cad_simulate_thermal",
] as const;

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
export type CadStatus = "active" | "waiting_user" | "ready" | "done" | "aborted";
export type MutationPolicy = "read_only" | "source_only" | "allowed";

export interface EvidenceInputArtifact {
  path: string;
  sha256: string;
  /** Provenance role, e.g. spec | artifact | fluidDomain. Opaque to the harness. */
  role: string;
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
  createdAt: string;
}

export interface CadRequirements {
  goal: string;
  evidenceObligations?: EvidenceObligations;
  deliverables: string[];
  must: string[];
  preferences: string[];
  assumptions: string[];
  openUnknowns: string[];
  /** Artifacts supplied by the user and bound by the baseline auto-action. */
  inputs?: string[];
}

export type EvidenceDisposition =
  | "required"
  | "optional"
  | "not_applicable"
  | "blocked_external";

/**
 * Opaque simulation case: the harness only knows that this interpreter
 * invocation must exist for the current artifact version. It deliberately
 * knows nothing about Mach numbers, RANS, or heat conduction.
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
  /** Route ontology: objective × lineage × structure × maturity (0.8). */
  route: Route | null;
  phase: CadPhase;
  status: CadStatus;
  mutationPolicy: MutationPolicy;

  /**
   * Phase-record types committed during this run (e.g. "assembly_design",
   * "interface_contracts"). Accumulated, never cleared — record guards and
   * reroute check them against route obligations.
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

  requirementsVersion?: string;
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
