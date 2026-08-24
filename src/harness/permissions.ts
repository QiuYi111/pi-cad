import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertRegistryContractCompatible, type RegistryContractV1 } from "./registry-contract.ts";
import type { RegistrySet } from "./registry.ts";
import type { HarnessRunStateV7 } from "./state.ts";
import type { WorkflowSnapshotV1 } from "./workflow/types.ts";

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
