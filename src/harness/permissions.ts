import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertRegistryContractCompatible, type RegistryContractV1 } from "./registry-contract.ts";
import type { RegistrySet } from "./registry.ts";
import type { HarnessRunStateV7 } from "./state.ts";
import type { WorkflowSnapshotV1 } from "./workflow/types.ts";

export type Operation =
  | "workspace.commit"
  | "model.build"
  | "probe.run"
  | "simulation.run"
  | "image.generate"
  | "review.submit"
  | "workflow.transition";

export type OperationAuthority = "author" | "reviewer" | "system";

export type Authorization =
  | { allowed: true; operation: Operation; effectiveCapabilities: string[] }
  | { allowed: false; operation: Operation; reason: string; legalNextActions: string[] };

const OPERATION_ACTIONS: Readonly<Record<Operation, readonly string[]>> = Object.freeze({
  "workspace.commit": ["cad_commit"],
  "model.build": ["cad_build_step"],
  "probe.run": ["cad_probe"],
  "simulation.run": ["cad_simulate"],
  "image.generate": ["codex_generate_image"],
  "review.submit": ["cad_submit_for_review"],
  "workflow.transition": ["transition", "cad_transition"],
});

const OPERATION_AUTHORITIES: Readonly<Partial<Record<Operation, readonly OperationAuthority[]>>> = Object.freeze({
  "workspace.commit": ["author", "system"],
  "model.build": ["author", "system"],
  "probe.run": ["author", "reviewer", "system"],
  "simulation.run": ["author", "system"],
  "image.generate": ["author", "system"],
  "review.submit": ["author", "system"],
  "workflow.transition": ["author", "system"],
});

function legalNextActions(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): string[] {
  const phase = phaseOf(state, workflow);
  const missingRecords = phase.recordObligations
    .filter((item) => item.required !== false && !state.records[item.ref])
    .map((item) => `${item.closeWith}: ${item.ref}`);
  const missingEvidence = phase.evidenceObligations
    .filter((item) => item.required !== false && !state.evidence.some((value) => value.obligationRef === item.ref))
    .map((item) => `${item.closeWith}: ${item.ref}`);
  const transitions = Object.entries(phase.transitions).map(([event, value]) => `transition ${event} -> ${value.target}`);
  return [...missingRecords, ...missingEvidence, ...transitions];
}

export function renderAuthorizationDenied(value: Extract<Authorization, { allowed: false }>): string {
  return `${value.operation} is unavailable.\n\n${renderReasonAndLegalNextActions(value.reason, value.legalNextActions)}`;
}

/** Shared renderer for denied operations and the corresponding Phase Card sections. */
export function renderReasonAndLegalNextActions(reason: string | null, legalNextActions: readonly string[]): string {
  const reasonLines = reason ? ["Reason", `- ${reason}`] : [];
  const renderedActions = renderLegalNextActionLines(legalNextActions);
  const nextLines = ["Legal next actions", ...(renderedActions.length ? renderedActions : ["- none"] )];
  return [...reasonLines, ...(reasonLines.length ? [""] : []), ...nextLines].join("\n");
}

export function renderLegalNextActionLines(legalNextActions: readonly string[]): string[] {
  return legalNextActions.map((item) => `- ${item}`);
}

export class AuthorizationDeniedError extends Error {
  readonly authorization: Extract<Authorization, { allowed: false }>;

  constructor(authorization: Extract<Authorization, { allowed: false }>) {
    super(renderAuthorizationDenied(authorization));
    this.name = "AuthorizationDeniedError";
    this.authorization = authorization;
  }
}

export interface ActionCardV1 {
  schema: 1;
  phase: string;
  purpose: string;
  actions: string[];
  grants: string[];
  writeScopes: string[];
  recordObligations: Array<{ ref: string; type: string; closeWith: string }>;
  evidenceObligations: Array<{ ref: string; type: string; closeWith: string; recipeKind?: string; requiredOutputs?: string[] }>;
  transitions: Array<{ event: string; target: string; authority?: string }>;
}

function phaseOf(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1) {
  if (state.workflow.hash !== workflow.hash) throw new Error("permission snapshot does not match state");
  const phase = workflow.phases[state.phase];
  if (!phase) throw new Error(`permission phase is absent from workflow: ${state.phase}`);
  return phase;
}

/**
 * Snapshot-driven permission projection. Live registrations are used only
 * after the pinned Registry Contract has proved their semantics compatible.
 */
export class PermissionEngineV7 {
  constructor(
    private readonly registries: RegistrySet,
    private readonly registryContract: RegistryContractV1,
  ) {
    assertRegistryContractCompatible(registryContract, registries);
  }

  actionCard(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): ActionCardV1 {
    const phase = phaseOf(state, workflow);
    return {
      schema: 1,
      phase: state.phase,
      purpose: phase.purpose,
      actions: [...phase.actions],
      grants: [...phase.grants],
      writeScopes: [...phase.writeScopes],
      recordObligations: phase.recordObligations.map(({ ref, type, closeWith }) => ({ ref, type, closeWith })),
      evidenceObligations: phase.evidenceObligations.map(({ ref, type, closeWith, recipeKind, requiredOutputs }) => ({ ref, type, closeWith, ...(recipeKind ? { recipeKind } : {}), ...(requiredOutputs ? { requiredOutputs: [...requiredOutputs] } : {}) })),
      transitions: Object.entries(phase.transitions).map(([event, value]) => ({ event, target: value.target, ...(value.authority ? { authority: value.authority } : {}) })),
    };
  }

  enabledActions(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): string[] {
    const phase = phaseOf(state, workflow);
    const enabled = new Set(phase.actions);
    for (const grantId of phase.grants) {
      const grant = this.registries.grants.require(grantId);
      const tools = (grant.contract.schema as Record<string, unknown>).tools;
      if (!Array.isArray(tools)) throw new Error(`grant has no pinned tool projection: ${grantId}`);
      for (const tool of tools) {
        if (typeof tool !== "string") throw new Error(`grant has invalid tool projection: ${grantId}`);
        this.registries.actions.require(tool);
        enabled.add(tool);
      }
    }
    return [...enabled].sort();
  }

  assertAction(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, action: string): void {
    if (!this.enabledActions(state, workflow).includes(action)) throw new Error(`action is not enabled in phase ${state.phase}: ${action}`);
  }

  assertWriteScope(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, scope: string): void {
    const phase = phaseOf(state, workflow);
    if (!phase.writeScopes.includes(scope)) throw new Error(`write scope is not enabled in phase ${state.phase}: ${scope}`);
  }
}

/** The authoritative workflow capability decision used by every Agent-facing operation. */
export function authorize(
  operation: Operation,
  state: HarnessRunStateV7,
  workflow: WorkflowSnapshotV1,
  permissions: PermissionEngineV7,
  authority: OperationAuthority = "author",
): Authorization {
  if (state.status !== "active" && state.status !== "ready") {
    return {
      allowed: false,
      operation,
      reason: `workflow ${state.workflow.id} is ${state.status}, not active`,
      legalNextActions: [],
    };
  }
  const authorities = OPERATION_AUTHORITIES[operation] ?? ["author"];
  if (!authorities.includes(authority)) {
    return {
      allowed: false,
      operation,
      reason: `${authority} authority cannot perform ${operation}`,
      legalNextActions: legalNextActions(state, workflow),
    };
  }
  const effectiveCapabilities = permissions.enabledActions(state, workflow);
  const required = OPERATION_ACTIONS[operation];
  if (!required.some((action) => effectiveCapabilities.includes(action))) {
    return {
      allowed: false,
      operation,
      reason: `${operation} is not granted in workflow phase ${state.phase}`,
      legalNextActions: legalNextActions(state, workflow),
    };
  }
  return { allowed: true, operation, effectiveCapabilities };
}

export function requireAuthorization(value: Authorization): asserts value is Extract<Authorization, { allowed: true }> {
  if (!value.allowed) throw new AuthorizationDeniedError(value);
}

export interface WriteScopeRule {
  scope: string;
  roots: string[];
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Domain packs provide path mappings; the generic Kernel only enforces the selected scope. */
export function assertScopedWrite(input: {
  cwd: string;
  target: string;
  enabledScopes: readonly string[];
  rules: readonly WriteScopeRule[];
}): void {
  const project = resolve(input.cwd);
  const target = resolve(project, input.target);
  if (!inside(project, target)) throw new Error(`write target escapes project root: ${input.target}`);
  for (const rule of input.rules) {
    if (!input.enabledScopes.includes(rule.scope)) continue;
    if (rule.roots.some((root) => inside(resolve(project, root), target))) return;
  }
  throw new Error(`write target is outside enabled scopes: ${input.target}`);
}
