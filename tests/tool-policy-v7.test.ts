import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { applyPatchTargets, authorizeMechanicalToolV7 } from "../src/domains/mechanical/tool-policy-v7.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import probe from "../src/extensions/probe/index.ts";

probe({ registerTool() {} } as any);

async function projectWithPolicy(kind: "read" | "recipe") {
  const cwd = await mkdtemp(join(tmpdir(), `pi-cad-tool-policy-${kind}-`));
  const grants = kind === "read" ? ["file_read", "shell"] : ["file_read", "shell", "file_edit_recipe"];
  const writeScopes = kind === "read" ? [] : ["project:recipe"];
  const workflow = compileWorkflowDefinition({
    schema: 1, id: `test/tool-policy-${kind}`, version: "1.0.0", parametersSchema: {}, initialPhase: "work",
    phases: {
      work: { purpose: "Work", actions: ["cad_probe"], grants, writeScopes, recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { done: { target: "end" } } },
      end: { purpose: "End", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    },
  }, mechanicalRegistries);
  await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
  return cwd;
}

test("v7 unified policy blocks nested shell and mutation aliases in read-only phases", async () => {
  const cwd = await projectWithPolicy("read");
  try {
    const shell = await authorizeMechanicalToolV7({ cwd, toolName: "exec_command", toolInput: { cmd: "touch escaped" } });
    assert.equal(shell?.block, true);
    assert.match(shell?.reason ?? "", /read_only/);
    const patch = await authorizeMechanicalToolV7({ cwd, toolName: "apply_patch", toolInput: "*** Begin Patch\n*** Add File: recipes/x.py\n+x\n*** End Patch" });
    assert.equal(patch?.block, true);
    assert.match(patch?.reason ?? "", /not enabled/);
    assert.equal(await authorizeMechanicalToolV7({ cwd, toolName: "cad_probe", toolInput: {} }), undefined);
    assert.equal(await authorizeMechanicalToolV7({ cwd, toolName: "goal_complete", toolInput: {} }), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("v7 unified policy validates every apply_patch target and exec workdir", async () => {
  const cwd = await projectWithPolicy("recipe");
  try {
    const allowed = await authorizeMechanicalToolV7({ cwd, toolName: "apply_patch", toolInput: "*** Begin Patch\n*** Add File: recipes/x.py\n+x\n*** End Patch" });
    assert.equal(allowed, undefined);
    const escapedMove = await authorizeMechanicalToolV7({ cwd, toolName: "apply_patch", toolInput: "*** Begin Patch\n*** Update File: recipes/x.py\n*** Move to: models/x.py\n@@\n-x\n+y\n*** End Patch" });
    assert.equal(escapedMove?.block, true);
    assert.match(escapedMove?.reason ?? "", /outside enabled scopes/);
    const workdir = await authorizeMechanicalToolV7({ cwd, toolName: "exec_command", toolInput: { cmd: "pwd", workdir: "../outside" } });
    assert.equal(workdir?.block, true);
    assert.match(workdir?.reason ?? "", /escapes/);
    assert.equal(await authorizeMechanicalToolV7({ cwd, toolName: "exec_command", toolInput: { cmd: "pwd", workdir: "recipes" } }), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("apply_patch target parser is fail-closed and includes move destinations", () => {
  assert.deepEqual(applyPatchTargets("*** Begin Patch\n*** Update File: recipes/a.py\n*** Move to: recipes/b.py\n@@\n-a\n+b\n*** End Patch"), ["recipes/a.py", "recipes/b.py"]);
  assert.throws(() => applyPatchTargets("not a patch"), /malformed/);
  assert.throws(() => applyPatchTargets("*** Begin Patch\n*** End Patch"), /no file targets/);
});
