/**
 * Pi-CAD wire, state, and workflow types.
 *
 * The state describes process and evidence only.  It never contains
 * engineering semantics ("this is a motor mount", "the design is safe").
 */

export const CAD_STATE_SCHEMA_VERSION = 3;
export const ALL_WORKFLOWS = [
  "quick",
  "analyze",
  "modify",
  "greenfield",
  "hybrid",
  "convert",
  "release",
] as const;
export const CONTROL_TOOLS = [
  "cad_route",
  "cad_commit_requirements",
  "cad_commit_plan",
  "cad_commit_candidate",
  "cad_transition",
  "cad_wait_for_user",
  "cad_finish",
] as const;
export const CAPABILITY_TOOLS = [
  "cad_build_step",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_export",
  "cad_run_simulation",
  "cad_generate_drawing",
  "cad_render_scene",
] as const;

export type CadWorkflow = (typeof ALL_WORKFLOWS)[number];
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
  | "intent"
  | "source_baseline"
  | "transform_plan"
  | "convert"
  | "compare"
  | "audit"
  | "gap_closure"
  | "package"
  | "final_review";
export type CadStatus = "active" | "waiting_user" | "ready" | "done" | "aborted";
export type CadMaturity =
  | "review"
  | "concept"
  | "prototype"
  | "engineering"
  | "manufacturing"
  | "release";
export type MutationPolicy = "read_only" | "source_only" | "allowed";

export interface EvidenceRef {
  id: string;
  kind:
    | "visual"
    | "geometry"
    | "build"
    | "compare"
    | "section"
    | "drawing"
    | "simulation"
    | "presentation"
    | "convert"
    | "assembly";
  tool: string;
  artifactHash: string;
  sourceHash?: string;
  paths: string[];
  createdAt: string;
}

export interface CadRequirements {
  goal: string;
  deliverables: string[];
  must: string[];
  preferences: string[];
  assumptions: string[];
  openUnknowns: string[];
  maturity: CadMaturity;
  /** Artifacts supplied by the user and bound by the baseline auto-action. */
  inputs?: string[];
}

export interface CadPlan {
  summary: string;
  protected: string[];
  plannedChanges: string[];
  interfaces: Array<Record<string, unknown>>;
  datums: string[];
  reviewPlan: string[];
  architecture?: string[];
  selectionRationale?: string;
  workstreams?: Array<{ name: string; status: "open" | "complete" | "not_applicable" | "blocked_external" }>;
}

export interface CadRunState {
  schemaVersion: number;
  runId: string;
  projectId: string;
  createdAt: string;
  workflow: CadWorkflow | null;
  phase: CadPhase;
  status: CadStatus;
  maturity: CadMaturity;
  mutationPolicy: MutationPolicy;

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
