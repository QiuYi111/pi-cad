import type { JsonValue } from "./canonical.ts";
import { Type } from "typebox";
import { buildRegistryContract } from "./registry-contract.ts";
import type { RegistrySet } from "./registry.ts";
import { HarnessProjectStoreV7, type LoadedHarnessRunV7 } from "./run-store.ts";
import { activeRunScope, resolveActiveRun } from "./run-scope.ts";
import { loadProjectWorkflowSelection, loadWorkflowSnapshot, type BuiltinWorkflowResolver } from "./workflow/loader.ts";
import type { WorkflowSnapshotV1 } from "./workflow/types.ts";

const TERMINAL_RUN_STATUSES = ["done", "aborted", "blocked_user", "blocked_external", "budget_exhausted"];

export const CadStartParamsSchema = Type.Object({
  reason: Type.String({ minLength: 1 }),
  interactionMode: Type.Optional(Type.Enum({ interactive: "interactive", headless: "headless" })),
}, { additionalProperties: false });

export async function cadStart(input: {
  cwd: string;
  registries: RegistrySet;
  builtins: ReadonlyMap<string, BuiltinWorkflowResolver>;
  reason: string;
  interactionMode?: "interactive" | "headless";
}): Promise<LoadedHarnessRunV7> {
  if (!input.reason.trim()) throw new Error("cad_start.reason is required");
  const selection = await loadProjectWorkflowSelection(input.cwd);
  const workflow = await loadWorkflowSnapshot({ cwd: input.cwd, selection, builtins: input.builtins, registries: input.registries });
  return cadStartSnapshot({
    cwd: input.cwd, registries: input.registries, workflow,
    parameters: selection.workflow.parameters as Record<string, JsonValue>,
    interactionMode: input.interactionMode,
  });
}

/** Start one already compiled package snapshot; source files are never consulted again by the run. */
export async function cadStartSnapshot(input: {
  cwd: string;
  registries: RegistrySet;
  workflow: WorkflowSnapshotV1;
  parameters?: Record<string, JsonValue>;
  interactionMode?: "interactive" | "headless";
}): Promise<LoadedHarnessRunV7> {
  const registryContract = buildRegistryContract(input.registries);
  const project = new HarnessProjectStoreV7(input.cwd);
  const scope = activeRunScope();
  if (scope) {
    // Conversation-scoped start: replace only this conversation's own run and
    // never touch the project-global run pointer.
    const existing = await resolveActiveRun(input.cwd, input.registries);
    if (existing && !TERMINAL_RUN_STATUSES.includes(existing.state.status)) {
      throw new Error(`cad_start cannot replace active v7 run ${existing.state.runId} bound to this Prime conversation`);
    }
    return project.startConversationRun({
      sessionId: scope.sessionId,
      workflow: input.workflow,
      registryContract,
      parameters: input.parameters ?? {},
      interactionMode: input.interactionMode,
    });
  }
  // cad_start is an explicit mutation/maintenance boundary; prompt context
  // never calls recovery.
  await project.transactions.recover();
  await project.reconcileCompletedRun(input.registries);
  const existing = await project.currentRun(input.registries);
  if (existing && !TERMINAL_RUN_STATUSES.includes(existing.state.status)) throw new Error(`cad_start cannot replace active v7 run ${existing.state.runId}`);
  // A project-scoped (headless) caller shares this project's files with every
  // running conversation, so it may not open a second writer behind their backs.
  const conversationRuns = await project.activeConversationRuns(input.registries);
  if (conversationRuns.length) throw new Error(`cad_start cannot start a project-scoped run while Prime conversation run ${conversationRuns[0]!.state.runId} is active`);
  return project.startRun({
    workflow: input.workflow,
    registryContract,
    parameters: input.parameters ?? {},
    interactionMode: input.interactionMode,
  });
}
