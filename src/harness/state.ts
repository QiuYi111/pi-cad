import type { JsonValue } from "./canonical.ts";

export type HarnessRunStatusV7 = "active" | "waiting_user" | "ready" | "done" | "aborted" | "blocked_user" | "blocked_external" | "budget_exhausted";

export interface WorkflowReplacementRefV7 {
  reason: string;
  authority?: string;
  predecessorHash: string;
  successorHash: string;
  at: string;
}

export interface RecordRefV7 {
  obligationRef: string;
  type: string;
  path: string;
  sha256: string;
  workflowHash: string;
  createdAt: string;
}

export interface EvidenceRefV7 {
  id: string;
  obligationRef: string;
  type: string;
  path: string;
  sha256: string;
  workflowHash: string;
  registryContractHash: string;
  computeIdentity?: string;
  createdAt: string;
}

export interface AuthorityRefV7 {
  id: string;
  kind: string;
  scope?: JsonValue;
  issuedAt: string;
  consumedAt?: string;
}

export interface HarnessRunStateV7 {
  schemaVersion: 7;
  kernelVersion: "v7";
  runId: string;
  projectId: string;
  workflow: {
    id: string;
    version: string;
    hash: string;
    snapshotPath: "workflow.json";
    registryContractHash: string;
    parameters: Record<string, JsonValue>;
    history: WorkflowReplacementRefV7[];
  };
  phase: string;
  phaseHistory: string[];
  status: HarnessRunStatusV7;
  interactionMode: "interactive" | "headless";
  records: Record<string, RecordRefV7>;
  artifacts: Record<string, { id: string; path: string; sha256: string; role: string }>;
  evidence: EvidenceRefV7[];
  staleEvidence: EvidenceRefV7[];
  authorities: AuthorityRefV7[];
  blocker?: { type: string; reason: string; needed: string };
  latestReview?: { id: string; verdict: string; path: string; profileId: string; subjectHash: string; workflowHash: string; registryContractHash: string };
  contextRefs?: Record<string, string>;
  domainMetadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeObligationBindingV7 {
  obligationRef: string;
  evidenceType: string;
  recipeKind: string;
  requiredOutputs: string[];
  workflowHash: string;
  registryContractHash: string;
  phaseAtPrepare: string;
}
