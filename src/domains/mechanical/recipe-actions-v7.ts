import { canonicalDigest } from "../../harness/canonical.ts";
import { PermissionEngineV7 } from "../../harness/permissions.ts";
import { commitRecipeEvidence } from "../../harness/recipe/commit.ts";
import { observeRecipeRun } from "../../harness/recipe/observer.ts";
import { commitRecipeArtifacts } from "../../harness/recipe/result.ts";
import { prepareAndRunRecipe } from "../../harness/recipe/runner.ts";
import { MechanicalRecipeRuntime } from "./recipe-runtime.ts";
import { loadRecipeObservation, loadRecipeRun } from "../../harness/recipe/store.ts";
import type { RecipeObservationSnapshotV1, RecipeRuntimeV1 } from "../../harness/recipe/types.ts";
import { HarnessProjectStoreV7 } from "../../harness/run-store.ts";
import { mechanicalRegistries } from "./registries.ts";

const TOOL_BY_KIND = {
  simulation: "cad_simulate",
  optimization: "cad_optimize",
  drawing: "cad_generate_drawing",
  presentation: "cad_render_scene",
  "analysis-model": "cad_derive_analysis_model",
} as const;

export type MechanicalRecipeKind = keyof typeof TOOL_BY_KIND;

async function current(cwd: string) {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!loaded) throw new Error("Recipe action requires an active v7 run");
  return loaded;
}

export async function runMechanicalRecipeV7(input: {
  cwd: string;
  kind: MechanicalRecipeKind;
  recipe: string;
  action?: string;
  obligationRef?: string;
  outputs?: string[];
  runtime?: RecipeRuntimeV1;
  signal?: AbortSignal;
}) {
  const harness = await current(input.cwd);
  new PermissionEngineV7(mechanicalRegistries, harness.registryContract).assertAction(harness.state, harness.workflow, TOOL_BY_KIND[input.kind]);
  return prepareAndRunRecipe({
    cwd: input.cwd,
    harness,
    registries: mechanicalRegistries,
    recipePath: input.recipe,
    expectedKind: input.kind,
    ...(input.action ? { action: input.action } : {}),
    ...(input.obligationRef ? { obligationRef: input.obligationRef } : {}),
    ...(input.outputs ? { outputs: input.outputs } : {}),
    runtime: input.runtime ?? new MechanicalRecipeRuntime(),
    signal: input.signal,
  });
}

export async function observeMechanicalRecipeV7(input: {
  cwd: string;
  run: string;
  runtime?: RecipeRuntimeV1;
  signal?: AbortSignal;
}): Promise<RecipeObservationSnapshotV1> {
  const harness = await current(input.cwd);
  const found = await loadRecipeRun({ cwd: input.cwd, workflowRunId: harness.state.runId, recipeRunId: input.run });
  return observeRecipeRun({ cwd: input.cwd, directory: found.directory, record: found.record, registries: mechanicalRegistries, runtime: input.runtime ?? new MechanicalRecipeRuntime(), signal: input.signal });
}

export async function commitMechanicalRecipeV7(input: {
  cwd: string;
  run: string;
  observation: RecipeObservationSnapshotV1;
}) {
  const harness = await current(input.cwd);
  const found = await loadRecipeRun({ cwd: input.cwd, workflowRunId: harness.state.runId, recipeRunId: input.run });
  if (!found.record.obligationBinding) return commitRecipeArtifacts({ cwd: input.cwd, workflowRunId: harness.state.runId, run: found.record, observation: input.observation, registries: mechanicalRegistries });
  return commitRecipeEvidence({
    cwd: input.cwd,
    workflowRunId: harness.state.runId,
    run: found.record,
    observation: input.observation,
    registries: mechanicalRegistries,
    adapter: {
      adapt({ run, observation }) {
        const digest = canonicalDigest(observation);
        const id = `evidence-${run.runId}-${observation.observationId}`;
        return {
          id,
          obligationRef: run.obligationBinding!.obligationRef,
          type: run.obligationBinding!.evidenceType,
          path: `evidence/${run.obligationBinding!.evidenceType}/${id}.json`,
          sha256: digest,
          workflowHash: run.workflowHash,
          registryContractHash: run.registryContractHash,
          computeIdentity: run.computeIdentity,
          createdAt: observation.createdAt,
        };
      },
    },
  });
}

export async function commitMechanicalRecipeByRefV7(input: { cwd: string; run: string; observation: string }) {
  const harness = await current(input.cwd);
  const found = await loadRecipeRun({ cwd: input.cwd, workflowRunId: harness.state.runId, recipeRunId: input.run });
  const observation = await loadRecipeObservation({ directory: found.directory, observationId: input.observation });
  return commitMechanicalRecipeV7({ cwd: input.cwd, run: input.run, observation });
}

export const cadSimulateV7 = (input: Omit<Parameters<typeof runMechanicalRecipeV7>[0], "kind">) => runMechanicalRecipeV7({ ...input, kind: "simulation" });
export const cadOptimizeV7 = (input: Omit<Parameters<typeof runMechanicalRecipeV7>[0], "kind">) => runMechanicalRecipeV7({ ...input, kind: "optimization" });
export const cadGenerateDrawingV7 = (input: Omit<Parameters<typeof runMechanicalRecipeV7>[0], "kind">) => runMechanicalRecipeV7({ ...input, kind: "drawing" });
export const cadRenderSceneV7 = (input: Omit<Parameters<typeof runMechanicalRecipeV7>[0], "kind">) => runMechanicalRecipeV7({ ...input, kind: "presentation" });
export const cadDeriveAnalysisModelV7 = (input: Omit<Parameters<typeof runMechanicalRecipeV7>[0], "kind" | "obligationRef">) => runMechanicalRecipeV7({ ...input, kind: "analysis-model" });

export async function executeMechanicalRecipeV7(input: Parameters<typeof runMechanicalRecipeV7>[0]) {
  const runtime = input.runtime ?? new MechanicalRecipeRuntime();
  const executed = await runMechanicalRecipeV7({ ...input, runtime });
  const observation = await observeMechanicalRecipeV7({ cwd: input.cwd, run: executed.record.runId, runtime, signal: input.signal });
  const committed = await commitMechanicalRecipeV7({ cwd: input.cwd, run: executed.record.runId, observation });
  return { ...executed, observation, committed };
}
