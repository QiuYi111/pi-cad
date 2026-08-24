import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { LocalRecipeRuntime } from "../src/harness/recipe/runtime.ts";
import { prepareAndRunRecipe } from "../src/harness/recipe/runner.ts";
import { observeRecipeRun } from "../src/harness/recipe/observer.ts";
import { commitRecipeEvidence } from "../src/harness/recipe/commit.ts";
import type { RecipeRuntimeV1 } from "../src/harness/recipe/types.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

const RECIPE_WORKFLOW = {
  schema: 1, id: "test/recipe", version: "1.0.0", parametersSchema: { type: "object", additionalProperties: false }, initialPhase: "review",
  phases: {
    review: {
      purpose: "Run Recipe", actions: ["commit_evidence", "transition"], grants: ["simulate", "transition"], writeScopes: ["run:evidence", "run:state"], recordObligations: [],
      evidenceObligations: [{ ref: "simulation:load-case-1", type: "simulation", closeWith: "commit_evidence", recipeKind: "simulation" }], contextProviders: ["kernel.current-action"], hooks: [], transitions: { accepted: { target: "done" } },
    },
    done: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
  },
} as const;

const MANIFEST = `schema: 1
id: simulation/test-case
version: 1.0.0
kind: simulation
runtimeProfile: torch-fem/torch-fem-0.9-cpu
inputs:
  - path: inputs/load.json
    role: load-case
    type: file
actions:
  run:
    argv: [/bin/bash, compute.sh]
    files: [compute.sh]
    timeoutSeconds: 5
observer:
  argv: [/bin/bash, observe.sh]
  files: [observe.sh]
  timeoutSeconds: 5
exports:
  result:
    type: artifact
    primary: true
resources:
  cpu: 1
  memoryGiB: 1
  workspaceGiB: 1
`;

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-recipe-kernel-"));
  await mkdir(join(cwd, "recipes", "case"), { recursive: true });
  await mkdir(join(cwd, "inputs"), { recursive: true });
  await writeFile(join(cwd, "recipes", "case", "pi-recipe.yaml"), MANIFEST);
  await writeFile(join(cwd, "recipes", "case", "compute.sh"), "set -eu\nprintf result > result.txt\n");
  await writeFile(join(cwd, "recipes", "case", "observe.sh"), "set -eu\nprintf '%s' '{\"schema\":1,\"exports\":{\"result\":{\"type\":\"artifact\",\"path\":\"recipes/case/result.txt\"}}}' > \"$PI_RECIPE_OBSERVATION_FILE\"\n");
  await writeFile(join(cwd, "recipes", "case", "undeclared-secret.txt"), "must-not-enter-frozen-closure\n");
  await chmod(join(cwd, "recipes", "case", "compute.sh"), 0o755);
  await chmod(join(cwd, "recipes", "case", "observe.sh"), 0o755);
  await writeFile(join(cwd, "inputs", "load.json"), "{\"force\":10}\n");
  return cwd;
}

test("Recipe Kernel validates, pre-binds, freezes and executes argv from the immutable workspace", async () => {
  const cwd = await fixture();
  try {
    const workflow = compileWorkflowDefinition(RECIPE_WORKFLOW, mechanicalRegistries);
    const contract = buildRegistryContract(mechanicalRegistries);
    const harness = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: contract });
    await assert.rejects(prepareAndRunRecipe({ cwd, harness, registries: mechanicalRegistries, recipePath: "recipes/case", runtime: new LocalRecipeRuntime() }), /requires obligationRef/);
    const result = await prepareAndRunRecipe({ cwd, harness, registries: mechanicalRegistries, recipePath: "recipes/case", obligationRef: "simulation:load-case-1", runtime: new LocalRecipeRuntime() });
    assert.equal(result.record.status, "completed");
    assert.equal(result.record.action, "run");
    assert.equal(result.record.obligationBinding?.obligationRef, "simulation:load-case-1");
    assert.equal(await readFile(join(result.directory, "workspace", "recipes", "case", "result.txt"), "utf-8"), "result");
    await assert.rejects(readFile(join(result.directory, "workspace", "recipes", "case", "undeclared-secret.txt")), /ENOENT/);
    assert.match(result.record.computeIdentity, /^[a-f0-9]{64}$/);
    const observation = await observeRecipeRun({ cwd, directory: result.directory, record: result.record, registries: mechanicalRegistries, runtime: new LocalRecipeRuntime() });
    assert.equal(observation.validForCommit, true);
    assert.equal(observation.exports[0]!.type, "artifact");
    const committed = await commitRecipeEvidence({
      cwd,
      workflowRunId: harness.state.runId,
      run: result.record,
      observation,
      registries: mechanicalRegistries,
      adapter: {
        adapt({ run, observation: snapshot }) {
          const artifact = snapshot.exports[0]!;
          return { id: "evidence-recipe-1", obligationRef: run.obligationBinding!.obligationRef, type: run.obligationBinding!.evidenceType, path: "evidence/simulation/evidence-recipe-1.json", sha256: artifact.sha256!, workflowHash: run.workflowHash, registryContractHash: run.registryContractHash, computeIdentity: run.computeIdentity, createdAt: new Date().toISOString() };
        },
      },
    });
    assert.equal(committed.state.evidence[0]!.obligationRef, "simulation:load-case-1");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Recipe Kernel detects a source change between validation and freeze and never starts compute", async () => {
  const cwd = await fixture();
  try {
    const workflow = compileWorkflowDefinition(RECIPE_WORKFLOW, mechanicalRegistries);
    const contract = buildRegistryContract(mechanicalRegistries);
    const harness = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: contract });
    let qualifyCalls = 0;
    let executeCalls = 0;
    const local = new LocalRecipeRuntime();
    const runtime: RecipeRuntimeV1 = {
      async qualify(root, profile) {
        qualifyCalls += 1;
        if (qualifyCalls === 1) await writeFile(join(cwd, "inputs", "load.json"), "{\"force\":99}\n");
        return local.qualify(root, profile);
      },
      async execute(input) { executeCalls += 1; return local.execute(input); },
    };
    await assert.rejects(prepareAndRunRecipe({ cwd, harness, registries: mechanicalRegistries, recipePath: "recipes/case", obligationRef: "simulation:load-case-1", runtime }), /changed between validation and freeze/);
    assert.equal(executeCalls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("observer must emit every explicitly requested non-primary output", async () => {
  const cwd = await fixture();
  try {
    await writeFile(join(cwd, "recipes", "case", "pi-recipe.yaml"), MANIFEST.replace("resources:\n", "  secondary:\n    type: artifact\n    primary: false\nresources:\n"));
    const workflow = compileWorkflowDefinition(RECIPE_WORKFLOW, mechanicalRegistries);
    const harness = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    const result = await prepareAndRunRecipe({ cwd, harness, registries: mechanicalRegistries, recipePath: "recipes/case", obligationRef: "simulation:load-case-1", outputs: ["secondary"], runtime: new LocalRecipeRuntime() });
    await assert.rejects(observeRecipeRun({ cwd, directory: result.directory, record: result.record, registries: mechanicalRegistries, runtime: new LocalRecipeRuntime() }), /omitted requested export: secondary/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("observer cannot mutate frozen compute or declared inputs", async () => {
  const cwd = await fixture();
  try {
    await writeFile(join(cwd, "recipes", "case", "observe.sh"), "set -eu\nprintf tampered > compute.sh\nprintf '%s' '{\"schema\":1,\"exports\":{\"result\":{\"type\":\"artifact\",\"path\":\"recipes/case/result.txt\"}}}' > \"$PI_RECIPE_OBSERVATION_FILE\"\n");
    const workflow = compileWorkflowDefinition(RECIPE_WORKFLOW, mechanicalRegistries);
    const harness = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    const result = await prepareAndRunRecipe({ cwd, harness, registries: mechanicalRegistries, recipePath: "recipes/case", obligationRef: "simulation:load-case-1", runtime: new LocalRecipeRuntime() });
    await assert.rejects(observeRecipeRun({ cwd, directory: result.directory, record: result.record, registries: mechanicalRegistries, runtime: new LocalRecipeRuntime() }), /modified a frozen Recipe program/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("observer can be repaired independently while compute and input revisions require a new run", async () => {
  const cwd = await fixture();
  try {
    const workflow = compileWorkflowDefinition(RECIPE_WORKFLOW, mechanicalRegistries);
    const harness = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    const result = await prepareAndRunRecipe({ cwd, harness, registries: mechanicalRegistries, recipePath: "recipes/case", obligationRef: "simulation:load-case-1", runtime: new LocalRecipeRuntime() });

    const repairedObserver = "set -eu\n# repaired without rerunning compute\nprintf '%s' '{\"schema\":1,\"exports\":{\"result\":{\"type\":\"artifact\",\"path\":\"recipes/case/result.txt\"}}}' > \"$PI_RECIPE_OBSERVATION_FILE\"\n";
    await writeFile(join(cwd, "recipes", "case", "observe.sh"), repairedObserver);
    const observation = await observeRecipeRun({ cwd, directory: result.directory, record: result.record, registries: mechanicalRegistries, runtime: new LocalRecipeRuntime() });
    assert.equal(observation.validForCommit, true);
    assert.notEqual(observation.observerHash, result.record.observerHash);
    assert.equal(observation.observerProgramFiles[0]!.path, "observe.sh");
    assert.equal(await readFile(join(result.directory, "observations", observation.observationId, "record", "program", "observe.sh"), "utf-8"), repairedObserver);
    const committed = await commitRecipeEvidence({
      cwd, workflowRunId: harness.state.runId, run: result.record, observation, registries: mechanicalRegistries,
      adapter: { adapt: ({ run, observation: snapshot }) => ({ id: "evidence-repaired-observer", obligationRef: run.obligationBinding!.obligationRef, type: run.obligationBinding!.evidenceType, path: "evidence/simulation/evidence-repaired-observer.json", sha256: snapshot.exports[0]!.sha256!, workflowHash: run.workflowHash, registryContractHash: run.registryContractHash, computeIdentity: run.computeIdentity, createdAt: new Date().toISOString() }) },
    });
    assert.equal(committed.state.evidence[0]!.id, "evidence-repaired-observer");

    await writeFile(join(cwd, "recipes", "case", "compute.sh"), "set -eu\nprintf changed > result.txt\n");
    await assert.rejects(observeRecipeRun({ cwd, directory: result.directory, record: result.record, registries: mechanicalRegistries, runtime: new LocalRecipeRuntime() }), /compute changed; prepare a new run/);
    await writeFile(join(cwd, "recipes", "case", "compute.sh"), "set -eu\nprintf result > result.txt\n");
    await writeFile(join(cwd, "inputs", "load.json"), "{\"force\":99}\n");
    await assert.rejects(observeRecipeRun({ cwd, directory: result.directory, record: result.record, registries: mechanicalRegistries, runtime: new LocalRecipeRuntime() }), /inputs? changed; prepare a new run/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
