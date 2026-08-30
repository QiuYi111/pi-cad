import type { JsonValue } from "../canonical.ts";

export interface WorkflowObligationDefinition {
  ref: string;
  type: string;
  closeWith: string;
  recipeKind?: string;
  /** Recipe exports that must be requested in addition to all primary exports. */
  requiredOutputs?: string[];
  /** Optional obligations are legal closure targets but do not block progress/finish. */
  required?: boolean;
  /** Obligation refs whose revision invalidates this result, transitively. */
  dependsOn?: string[];
}

export interface WorkflowTransitionDefinition {
  target: string;
  authority?: string;
  terminalStatus?: string;
  requiresPhaseObligations?: boolean;
  reviewVerdicts?: Array<"pass" | "fail" | "clarification_required" | "unresolved">;
  requiresVisited?: string[];
  forbidsVisited?: string[];
  invalidate?: string[];
}

export interface WorkflowPhaseDefinition {
  purpose: string;
  /** Compact phase-local SOP rendered into the Agent-facing Phase Card. */
  guidance?: string;
  /** Non-authoritative Python working structures suggested for this phase. */
  recommendedTemplates?: string[];
  /** Non-authoritative Prime skills suggested for this phase. */
  recommendedSkills?: string[];
  actions: string[];
  grants: string[];
  writeScopes: string[];
  recordObligations: WorkflowObligationDefinition[];
  evidenceObligations: WorkflowObligationDefinition[];
  contextProviders: string[];
  hooks: string[];
  reviewProfile?: string;
  transitions: Record<string, WorkflowTransitionDefinition>;
  terminal?: boolean;
}

export interface WorkflowDefinitionV1 {
  schema: 1;
  id: string;
  version: string;
  parametersSchema: JsonValue;
  initialPhase: string;
  phases: Record<string, WorkflowPhaseDefinition>;
}

export interface WorkflowSnapshotV1 extends WorkflowDefinitionV1 {
  hash: string;
}

export interface ProjectWorkflowSelectionV1 {
  schema: 1;
  workflow: {
    source: string;
    parameters: Record<string, JsonValue>;
  };
}
