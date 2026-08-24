import { canonicalDigest, jsonValue } from "../canonical.ts";
import type { RegistrySet } from "../registry.ts";
import { HarnessRunStoreV7 } from "../run-store.ts";
import type { RecipeObservationSnapshotV1, RecipeRunRecordV1 } from "./types.ts";

function verify(run: RecipeRunRecordV1, observation: RecipeObservationSnapshotV1): void {
  if (!observation.validForCommit || observation.runId !== run.runId) throw new Error("Recipe observation is not valid for result commit");
}

/** Commit artifact/record Recipe results without granting Evidence authority. */
export async function commitRecipeArtifacts(input: {
  cwd: string;
  workflowRunId: string;
  run: RecipeRunRecordV1;
  observation: RecipeObservationSnapshotV1;
  registries: RegistrySet;
}) {
  if (input.run.obligationBinding) throw new Error("Evidence-bound Recipe must use commitRecipeEvidence");
  verify(input.run, input.observation);
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  return store.mutate(input.registries, ({ state, workflow, registryContract }) => {
    if (input.run.workflowHash !== workflow.hash || input.run.registryContractHash !== registryContract.hash) throw new Error("Recipe result binding is stale");
    const artifacts = { ...state.artifacts };
    for (const item of input.observation.exports) {
      if (!item.path || !item.sha256) continue;
      const id = `${input.run.runId}:${item.name}`;
      const path = `.pi-cad/runs/${input.workflowRunId}/recipe-runs/${input.run.runId}/workspace/${item.path}`;
      const existing = artifacts[id];
      if (existing && (existing.sha256 !== item.sha256 || existing.path !== path)) throw new Error(`Recipe artifact identity collision: ${id}`);
      artifacts[id] = { id, path, sha256: item.sha256, role: `${input.run.recipeKind}:${item.name}` };
    }
    const resultId = canonicalDigest({ recipeRunId: input.run.runId, observationId: input.observation.observationId });
    return {
      state: { ...state, artifacts, domainMetadata: { ...(state.domainMetadata ?? {}), [`recipe-result:${input.run.runId}`]: resultId }, updatedAt: new Date().toISOString() },
      event: { type: "RecipeResultCommitted", data: { recipeRunId: input.run.runId, observationId: input.observation.observationId, resultId } },
      payloads: { [`records/recipe-results/${resultId}.json`]: jsonValue({ schema: 1, resultId, run: input.run, observation: input.observation }) },
    };
  });
}
