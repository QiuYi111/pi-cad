import { commitBoundEvidence } from "../reducer.ts";
import { HarnessRunStoreV7 } from "../run-store.ts";
import type { EvidenceRefV7 } from "../state.ts";
import type { RegistrySet } from "../registry.ts";
import type { RecipeObservationSnapshotV1, RecipeRunRecordV1 } from "./types.ts";

export interface RecipeResultAdapterV1 {
  adapt(input: { run: RecipeRunRecordV1; observation: RecipeObservationSnapshotV1 }): EvidenceRefV7;
}

export async function commitRecipeEvidence(input: {
  cwd: string;
  workflowRunId: string;
  run: RecipeRunRecordV1;
  observation: RecipeObservationSnapshotV1;
  registries: RegistrySet;
  adapter: RecipeResultAdapterV1;
}) {
  if (!input.run.obligationBinding) throw new Error("Recipe run has no pre-bound Evidence obligation");
  if (!input.observation.validForCommit || input.observation.runId !== input.run.runId) throw new Error("Recipe observation is not valid for commit");
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  return store.mutate(input.registries, ({ state, workflow, registryContract }) => {
    const evidence = input.adapter.adapt({ run: input.run, observation: input.observation });
    const next = commitBoundEvidence({ state, workflow, registryContract, binding: input.run.obligationBinding!, evidence });
    return {
      state: next,
      event: { type: "RecipeEvidenceCommitted", data: { recipeRunId: input.run.runId, observationId: input.observation.observationId, obligationRef: input.run.obligationBinding!.obligationRef, evidenceId: evidence.id } },
      payloads: { [evidence.path]: { schema: 1, evidence, recipeRun: input.run.runId, observation: input.observation.observationId } },
    };
  });
}
