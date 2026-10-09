import { jsonValue } from "../harness/canonical.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";
import { executeMechanicalRecipeV7 } from "../domains/mechanical/recipe-actions-v7.ts";

export async function simulationRun(cwd: string, request: Extract<AgentApiRequest, { op: "simulation-run" }>) {
  const executed = await executeMechanicalRecipeV7({ cwd, kind: "simulation", recipe: request.recipe, action: request.action, obligationRef: request.obligationRef, outputs: request.outputs });
  return jsonValue({
    runId: executed.record.runId, recipeId: executed.record.recipeId, status: executed.record.status,
    computeIdentity: executed.record.computeIdentity, observation: executed.observation,
  });
}
