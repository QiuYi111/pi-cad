/**
 * V0 wire and state types for Pi-CAD.
 *
 * These types deliberately describe process and evidence only.  They do not
 * contain engineering semantics ("this is a motor mount", "the design is
 * safe") because tools expose reality and only the Agent interprets it.
 */

export const CAD_STATE_SCHEMA_VERSION = 1;
export const V0_WORKFLOW = "quick" as const;
export const V0_CONTROL_TOOLS = [
  "cad_route",
  "cad_commit_requirements",
  "cad_commit_candidate",
  "cad_transition",
  "cad_finish",
] as const;
export const V0_CAPABILITY_TOOLS = [
  "cad_build_step",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_measure",
] as const;

export type CadWorkflow = "quick";
export type CadPhase =
  | "intake"
  | "requirements"
  | "build"
  | "review"
  | "ready"
  | "done";
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
  kind: "visual" | "geometry" | "build";
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
}

export interface CadProjectState {
  schemaVersion: number;
  taskId: string;
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

  evidence: EvidenceRef[];
  staleEvidence: EvidenceRef[];
  activeWorkstreams: string[];
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
