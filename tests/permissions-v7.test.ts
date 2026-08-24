import assert from "node:assert/strict";
import { test } from "node:test";

import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { PermissionEngineV7, assertScopedWrite } from "../src/harness/permissions.ts";
import { createHarnessRunState } from "../src/harness/reducer.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("Permission Engine derives overlay and Action Card only from compatible snapshots", () => {
  const workflow = compileWorkflowDefinition({
    schema: 1, id: "test/permissions", version: "1.0.0", parametersSchema: {}, initialPhase: "work",
    phases: {
      work: { purpose: "Work", actions: ["transition"], grants: ["file_read", "file_edit_recipe"], writeScopes: ["project:recipe"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { done: { target: "end" } } },
      end: { purpose: "End", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    },
  }, mechanicalRegistries);
  const contract = buildRegistryContract(mechanicalRegistries);
  const state = createHarnessRunState({ runId: "run", projectId: "project", workflow, registryContract: contract });
  const engine = new PermissionEngineV7(mechanicalRegistries, contract);
  assert.deepEqual(engine.enabledActions(state, workflow), ["edit", "find", "grep", "ls", "read", "transition", "write"]);
  assert.equal(engine.actionCard(state, workflow).purpose, "Work");
  assert.throws(() => engine.assertAction(state, workflow, "bash"), /not enabled/);
  engine.assertWriteScope(state, workflow, "project:recipe");
});

test("domain path mapping cannot expand a snapshot write scope", () => {
  const rules = [{ scope: "project:recipe", roots: ["recipes", "simulation"] }];
  assert.doesNotThrow(() => assertScopedWrite({ cwd: "/tmp/project", target: "recipes/case/run.py", enabledScopes: ["project:recipe"], rules }));
  assert.throws(() => assertScopedWrite({ cwd: "/tmp/project", target: "models/part.py", enabledScopes: ["project:recipe"], rules }), /outside enabled scopes/);
  assert.throws(() => assertScopedWrite({ cwd: "/tmp/project", target: "../escape", enabledScopes: ["project:recipe"], rules }), /escapes project root/);
});
