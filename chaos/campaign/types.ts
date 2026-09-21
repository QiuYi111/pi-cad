import type { FaultOutcome } from "../reify/types.ts";

/** The real boundaries the fault space is grouped by. */
export type FaultBoundary = "process" | "file-state" | "provider-oauth" | "race";

/** How one campaign round ended. */
export type RoundStatus = "passed" | "failed" | "error";

/**
 * What a unique failure really is, decided by replaying it, not by trusting
 * the round that first produced it.
 */
export type FailureVerdict = "reproducible" | "flaky" | "false-positive" | "unverified";

/**
 * Whether a failure is a real product finding or the harness tripping over its
 * own fault injection. A harness failure still needs a fix, but it must never
 * be reported as a product bug.
 */
export type FailureNature = "product" | "harness";

/** The named campaign shapes the issue asks for. */
export type CampaignMode = "short" | "nightly" | "targeted";

/** One real round: what it generated, what it hit, what came out. */
export interface CampaignRound {
  index: number;
  /** The seed handed to fast-check for this round. */
  seed: number;
  /** The seed fast-check reports back; what replay uses. */
  effectiveSeed?: number;
  profile: string;
  runtimeMode: boolean;
  maxCommands: number;
  faultScope: string[] | null;
  startedAt: string;
  durationMs: number;
  status: RoundStatus;
  invariant?: string;
  detail?: string;
  artifactPath?: string;
  campaignArtifact?: string;
  replayPath?: string;
  originalLength?: number;
  shrunkLength?: number;
  numShrinks?: number;
  faultOutcomes: FaultOutcome[];
  /** Commands this round really executed, in order (`kind:name`). */
  commands: string[];
  injectedFaults: string[];
  notApplicableFaults: string[];
  /** Boundaries really hit (injected faults), not the profile's target. */
  boundariesHit: FaultBoundary[];
  /** Real components this round's commands touched. */
  componentsTouched: string[];
  recoveries: number;
  error?: string;
}

/** Everything needed to re-run this campaign byte-for-byte. */
export interface CampaignManifest {
  campaignId: string;
  createdAt: string;
  mode: CampaignMode;
  seed: number;
  rounds: number;
  maxCommands: number;
  runtimeRatio: number;
  providerFaults: boolean;
  profiles: string[];
  concurrency: number;
  triageReplays: number;
  faultPool: string[];
  version: {
    package: string;
    node: string;
    gitCommit: string;
    gitBranch: string;
    gitDirty: boolean;
  };
  environment: Record<string, string | null>;
  /** Set when this campaign re-runs another one. */
  parentCampaignId?: string;
}

/** One round of the deterministic schedule. */
export interface PlannedRound {
  index: number;
  seed: number;
  profile: string;
  runtimeMode: boolean;
  maxCommands: number;
  faultScope: string[] | null;
}

/** What replaying a unique failure really showed. */
export interface TriageResult {
  attempts: number;
  reproductions: number;
  sequenceReplayOk: boolean;
  seedPathReplayOk: boolean;
  shrinkOk: boolean;
  originalLength: number;
  shrunkLength: number;
  numShrinks: number;
  /** The minimal sequence that still reproduces, when shrink worked. */
  minimalSequence: string[];
  enrichedArtifact?: string;
  notes: string[];
}

/** Failures grouped by what they really are, so one bug is one cluster. */
export interface FailureCluster {
  id: string;
  signature: string;
  invariant: string;
  boundary: FaultBoundary | "unknown";
  nature: FailureNature;
  /** Every step that was running when it broke, for human review. */
  failingSteps: string[];
  reason: string;
  /** Every harness log line seen for this failure, for human review. */
  logSignatures: string[];
  /** Every distinct sequence shape that landed in this cluster. */
  shapes: string[][];
  occurrences: number;
  roundIndexes: number[];
  seeds: number[];
  artifactPaths: string[];
  representative: string;
  firstSeenAt: string;
  lastSeenAt: string;
  runtimeModes: boolean[];
  commits: string[];
  verdict: FailureVerdict;
  triage?: TriageResult;
}

export interface CampaignCoverage {
  rounds: number;
  roundsPassed: number;
  roundsFailed: number;
  roundsErrored: number;
  distinctSeeds: number;
  /** Total real state observations recorded across the campaign. */
  stateObservations: number;
  actions: Record<string, number>;
  faultsInjected: Record<string, number>;
  faultsNotApplicable: Record<string, number>;
  invariantsChecked: string[];
  boundaries: Record<string, { rounds: number; injected: number }>;
  components: Record<string, number>;
  profiles: Record<string, number>;
  runtimeRounds: number;
  oneShotRounds: number;
}

export interface CampaignReport {
  campaignId: string;
  createdAt: string;
  manifest: CampaignManifest;
  coverage: CampaignCoverage;
  failures: {
    rounds: number;
    unique: number;
    reproducible: number;
    flaky: number;
    falsePositive: number;
    unverified: number;
    /** Real product findings vs the harness tripping over itself. */
    product: number;
    harness: number;
  };
  clusters: FailureCluster[];
  underExplored: string[];
  notes: string[];
}
