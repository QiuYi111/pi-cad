import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import simulation from "../src/extensions/simulation/index.ts";
import core from "../src/extensions/core/index.ts";
import { cadOptimizeV7, commitMechanicalRecipeV7, observeMechanicalRecipeV7 } from "../src/domains/mechanical/recipe-actions-v7.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { LocalRecipeRuntime } from "../src/harness/recipe/runtime.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

function registerSimulationActions() {
  const pi: any = { registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; }, appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} } };
  core(pi);
  simulation(pi);
}

test("Mechanical Recipe actions enforce kind and use the generic artifact commit path", async () => {
  registerSimulationActions();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-mechanical-recipe-"));
  try {
    await mkdir(join(cwd, "recipes", "optimization"), { recursive: true });
    await writeFile(join(cwd, "recipes", "optimization", "pi-recipe.yaml"), `schema: 1
id: optimization/test
version: 1.0.0
kind: optimization
runtimeProfile: torch-fem/torch-fem-0.9-cpu
inputs: []
actions:
  explore:
    argv: [/bin/bash, run.sh]
    files: [run.sh]
    timeoutSeconds: 5
observer:
  argv: [/bin/bash, observe.sh]
  files: [observe.sh]
  timeoutSeconds: 5
exports:
  density:
    type: artifact
    primary: true
resources: {cpu: 1, memoryGiB: 1, workspaceGiB: 1}
`);
    await writeFile(join(cwd, "recipes", "optimization", "run.sh"), "set -eu\nprintf density > density.bin\n");
    await writeFile(join(cwd, "recipes", "optimization", "observe.sh"), "set -eu\nprintf '%s' '{\"schema\":1,\"exports\":{\"density\":{\"type\":\"artifact\",\"path\":\"recipes/optimization/density.bin\"}}}' > \"$PI_RECIPE_OBSERVATION_FILE\"\n");
    await chmod(join(cwd, "recipes", "optimization", "run.sh"), 0o755);
    await chmod(join(cwd, "recipes", "optimization", "observe.sh"), 0o755);
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/optimization", version: "1.0.0", parametersSchema: {}, initialPhase: "work", phases: {
      work: { purpose: "Optimize", actions: ["cad_optimize", "transition"], grants: ["optimize", "transition"], writeScopes: ["project:recipe", "run:evidence", "run:observation", "run:state"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { done: { target: "end" } } },
      end: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await assert.rejects(cadOptimizeV7({ cwd, recipe: "recipes/optimization", action: "missing", runtime: new LocalRecipeRuntime() }), /not declared/);
    const executed = await cadOptimizeV7({ cwd, recipe: "recipes/optimization", action: "explore", runtime: new LocalRecipeRuntime() });
    const observation = await observeMechanicalRecipeV7({ cwd, run: executed.record.runId, runtime: new LocalRecipeRuntime() });
    const committed = await commitMechanicalRecipeV7({ cwd, run: executed.record.runId, observation });
    assert.equal(Object.keys(committed.state.artifacts).length, 1);
    assert.match(Object.values(committed.state.artifacts)[0]!.role, /^optimization:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
