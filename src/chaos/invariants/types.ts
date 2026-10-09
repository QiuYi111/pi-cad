import type { JsonValue } from "../../harness/canonical.ts";
import type { HarnessProjectStateV7 } from "../../harness/run-store.ts";
import type { HarnessRunStateV7, RecordRefV7, EvidenceRefV7 } from "../../harness/state.ts";
import type { StatusProjectionV1 } from "../../authority/storage.ts";
import type { WorkspaceCommitManifestV1 } from "../../harness/commit.ts";

/**
 * Priority of an invariant, read the same way the ticket reads it:
 * P0 = violation means the system is wrong; P1 = high-risk consistency /
 * recovery rule; P2 = long-campaign quality rule.
 */
export type InvariantSeverity = "P0" | "P1" | "P2";

/** One observed artifact/evidence/record file and its real on-disk identity. */
export interface FileIdentityObservation {
  /** Logical id (artifact id, evidence id, record ref). */
  id: string;
  /** Path as recorded in Reify state. */
  recordedPath: string;
  /** Absolute path the checker actually read. */
  absolutePath: string;
  /** Identity recorded in Reify state. */
  recordedSha256: string;
  /**
   * Observed identity using the rule Reify actually uses for this kind of
   * reference: file bytes for artifacts, canonical digest of the stored
   * payload (or its `envelope`) for records and evidence.
   */
  observedSha256: string | null;
  /** Raw file hash, kept for evidence even when the rule is content-based. */
  observedFileSha256: string | null;
  /** How Reify defines the recorded identity for this reference. */
  digestRule: "file-bytes" | "canonical-content" | "referenced-file";
  /** Where the bytes live: project workspace or the run transaction store. */
  location: "project" | "run-store";
}

/** A transaction lock file that names the process allowed to write a store. */
export interface LockObservation {
  path: string;
  pid: number | null;
  /** null when liveness could not be decided. */
  ownerAlive: boolean | null;
  createdAt: string | null;
  /** Seconds since the lock file was last touched. */
  ageMs: number;
}

/** A leftover `*.staging-<pid>` directory from an interrupted recipe prepare. */
export interface StagingObservation {
  path: string;
  pid: number | null;
  ownerAlive: boolean | null;
  ageMs: number;
}

/** A recipe run record, read from the recipe's own transaction store. */
export interface RecipeRunObservation {
  workflowRunId: string;
  recipeRunId: string;
  status: string;
  createdAt: string | null;
  completedAt: string | null;
  generation: number | null;
  /** Seconds since the recipe record last advanced. */
  idleMs: number;
  /** True when the recipe directory has an unfinished staging sibling. */
  hasStaging: boolean;
}

/** Minimal workflow projection the checkers need to bind evidence to obligations. */
export interface WorkflowObligationView {
  ref: string;
  type: string;
  closeWith: string;
}

export interface WorkflowView {
  id: string;
  version: string;
  hash: string;
  initialPhase: string;
  phases: Record<string, { recordObligations: WorkflowObligationView[]; evidenceObligations: WorkflowObligationView[] }>;
}

export interface ReifyRunSnapshot {
  runId: string;
  directory: string;
  /** True when a materialized `state.json` exists. */
  materialized: boolean;
  state: HarnessRunStateV7 | null;
  stateError: string | null;
  /** SHA-256 of the materialized `state.json`. */
  materializedStateSha256: string | null;
  /** SHA-256 of the payload `state.json` published by the HEAD transaction. */
  headStateSha256: string | null;
  headGeneration: number | null;
  headError: string | null;
  /** Hash-chain problems found while walking the published transaction ancestry. */
  transactionErrors: string[];
  /** Every published generation event, in commit order. */
  events: Array<{ type: string; data?: JsonValue }>;
  eventLineCount: number;
  /** Published run status per generation, oldest first. */
  statusTimeline: Array<{ generation: number; status: string; phase: string }>;
  /** Milliseconds since the run's HEAD transaction was last advanced. */
  advanceAgeMs: number | null;
  /** Pinned workflow snapshot, or null when it could not be read. */
  workflow: WorkflowView | null;
  workflowError: string | null;
  artifacts: FileIdentityObservation[];
  evidence: FileIdentityObservation[];
  records: FileIdentityObservation[];
  commits: WorkspaceCommitManifestV1[];
  commitIndex: string[];
  /** Index entries whose manifest file is missing, or whose id does not match the entry. */
  commitErrors: string[];
  /** Commit manifests whose producer named a session, oldest first. */
  commitSessions: string[];
  recipeRuns: RecipeRunObservation[];
  locks: LockObservation[];
  staging: StagingObservation[];
  /** Transaction directories that never published a commit. */
  unpublishedTransactions: Array<{ txId: string; ageMs: number }>;
  /** Record refs whose obligation was never closed by the current workflow. */
  recordRefs: RecordRefV7[];
  evidenceRefs: EvidenceRefV7[];
}

export interface ReifyProjectSnapshot {
  cwd: string;
  storageRoot: string;
  /** Where `storageRoot` came from when several candidate stores exist. */
  storageRootSource: "env" | "explicit" | "only-candidate" | "newest-candidate" | "workspace-default";
  /** Every store candidate for this project, newest first by project updatedAt. */
  storageRootCandidates: Array<{ root: string; source: "env" | "canonical" | "workspace"; projectUpdatedAt: string | null; hasState: boolean }>;
  projectDirectory: string;
  projectState: HarnessProjectStateV7 | null;
  projectStateError: string | null;
  projectHeadGeneration: number | null;
  /** Milliseconds since the project store's HEAD was last advanced. */
  projectAdvanceAgeMs: number | null;
  projectHeadError: string | null;
  projectTransactionErrors: string[];
  projectMaterializedStateSha256: string | null;
  projectHeadStateSha256: string | null;
  projectEventLineCount: number;
  /** Run ids listed in `v7-project/state.json`. */
  listedRunIds: string[];
  /** Run ids that actually have a directory under `runs/`. */
  presentRunIds: string[];
  runs: ReifyRunSnapshot[];
  /** Files published as Project Head, resolved against the project root. */
  headArtifacts: FileIdentityObservation[];
  projection: StatusProjectionV1 | null;
  projectionPath: string;
  projectionError: string | null;
  projectionAgeMs: number | null;
  projectLocks: LockObservation[];
  /** Project-level transaction directories that never published a commit. */
  unpublishedTransactions: Array<{ txId: string; ageMs: number }>;
  now: number;
}

export interface InvariantViolation {
  name: string;
  severity: InvariantSeverity;
  scope: string;
  detail: string;
  evidence: Record<string, JsonValue>;
}

export interface ReifyInvariantContext {
  project: ReifyProjectSnapshot;
  now: number;
  /** Read an optional grace/budget override, already defaulted by the caller. */
  graceMs: number;
}

export interface ReifyInvariantDefinition {
  name: string;
  severity: InvariantSeverity;
  scope: string;
  /** Short statement of the rule. */
  title: string;
  /** Why the rule exists. */
  why: string;
  /** Real Reify state this rule reads. */
  stateSources: string[];
  /** Allowed grace window before an observation counts as a violation. */
  graceMs: number;
  /** Optional convergence budget, when the rule is about bounded recovery. */
  budgetMs?: number;
  check(context: ReifyInvariantContext): Promise<void> | void;
}

export class InvariantViolationError extends Error {
  constructor(readonly violation: InvariantViolation) {
    super(`[${violation.severity}] ${violation.name}: ${violation.detail}`);
    this.name = "InvariantViolationError";
  }
}
