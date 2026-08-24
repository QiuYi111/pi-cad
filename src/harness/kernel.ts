import type { JsonValue } from "./canonical.ts";
import { Type } from "typebox";
import { buildRegistryContract } from "./registry-contract.ts";
import type { RegistrySet } from "./registry.ts";
import { HarnessProjectStoreV7, type LoadedHarnessRunV7 } from "./run-store.ts";
import { loadProjectWorkflowSelection, loadWorkflowSnapshot, type BuiltinWorkflowResolver } from "./workflow/loader.ts";

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
  const registryContract = buildRegistryContract(input.registries);
  const project = new HarnessProjectStoreV7(input.cwd);
  // cad_start is an explicit mutation/maintenance boundary; prompt context
  // never calls recovery.
  await project.transactions.recover();
  await project.reconcileCompletedRun(input.registries);
  const existing = await project.currentRun(input.registries);
  if (existing && !["done", "aborted", "blocked_user", "blocked_external", "budget_exhausted"].includes(existing.state.status)) throw new Error(`cad_start cannot replace active v7 run ${existing.state.runId}`);
  return project.startRun({
    workflow,
    registryContract,
    parameters: selection.workflow.parameters as Record<string, JsonValue>,
    interactionMode: input.interactionMode,
  });
}
