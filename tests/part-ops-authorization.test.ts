import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

// An observe-only phase allows probe.run but not model.build, which is exactly
// the line between the read-only and the mutating part-* operations.
function observeOnlyWorkflow() {
  return compileWorkflowDefinition({
    schema: 1, id: "test/part-authorization", version: "1.0.0", parametersSchema: {}, initialPhase: "inspect",
    phases: {
      inspect: {
        purpose: "Look at the model without changing it", actions: ["transition"], grants: ["observe", "transition"],
        writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [],
        transitions: { finished: { target: "done" } },
      },
      done: {
        purpose: "Done", actions: [], grants: [], writeScopes: [], recordObligations: [], evidenceObligations: [],
        contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
      },
    },
  }, mechanicalRegistries);
}

async function withProject(run: (cwd: string) => Promise<void>, started = true): Promise<void> {
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-part-auth-canonical-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-part-auth-"));
  const saved = {
    canonical: process.env.PI_CAD_CANONICAL_PROJECT_DIR,
    python: process.env.PI_CAD_FREECAD_PYTHON,
    home: process.env.PI_CAD_FREECAD_HOME,
  };
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  // No FreeCAD anywhere: an operation that passes authorization stops at FREECAD_NOT_INSTALLED.
  delete process.env.PI_CAD_FREECAD_PYTHON;
  process.env.PI_CAD_FREECAD_HOME = join(canonical, "no-freecad");
  try {
    if (started) await new HarnessProjectStoreV7(cwd).startRun({ workflow: observeOnlyWorkflow(), registryContract: buildRegistryContract(mechanicalRegistries) });
    await run(cwd);
  } finally {
    for (const [key, value] of [["PI_CAD_CANONICAL_PROJECT_DIR", saved.canonical], ["PI_CAD_FREECAD_PYTHON", saved.python], ["PI_CAD_FREECAD_HOME", saved.home]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
  }
}

const doc = "parts/bracket.FCStd";
const mutating = [
  { schema: 1, op: "part-open", doc, create: true },
  { schema: 1, op: "part-apply", doc, ops: [{ op: "param", name: "w", value: 1 }] },
  { schema: 1, op: "part-undo", doc },
] as const;
const reading = [
  { schema: 1, op: "part-try", doc, ops: [{ op: "param", name: "w", value: 1 }] },
  { schema: 1, op: "part-tree", doc },
  { schema: 1, op: "part-query", doc, target: "bracket/base" },
  { schema: 1, op: "part-check", doc, kind: "mass", args: {} },
  { schema: 1, op: "part-sweep", doc, param: "w", range: [0, 1], step: 0.5, check: { kind: "mass", args: {} } },
  { schema: 1, op: "part-dfm", doc, layers: ["lint", "geometry"] },
] as const;

test("every part operation needs an active workflow", async () => {
  await withProject(async (cwd) => {
    for (const request of [...mutating, ...reading]) {
      await assert.rejects(handleAgentApi(cwd, request as never), /cad\.workflow\.start/, request.op);
    }
  }, false);
});

test("part-open, part-apply and part-undo need model.build; the others need only probe.run", async () => {
  await withProject(async (cwd) => {
    for (const request of mutating) {
      await assert.rejects(handleAgentApi(cwd, request as never), /model\.build is not granted/, request.op);
    }
    for (const request of reading) {
      await assert.rejects(handleAgentApi(cwd, request as never), (error: any) => error.name === "PartOpError" && error.code === "FREECAD_NOT_INSTALLED", request.op);
    }
  });
});

test("a read-only author may run trial and read operations but not change the part", async () => {
  await withProject(async (cwd) => {
    for (const request of mutating) {
      const denied = await dispatchSidecarRequest("author", cwd, request as never, undefined, undefined, { authorReadOnly: true });
      assert.equal(denied.ok, false, request.op);
      assert.match(denied.error!.message, /desktop read-only mode denies operation/, request.op);
    }
    const read = await dispatchSidecarRequest("author", cwd, reading[1] as never, undefined, undefined, { authorReadOnly: true });
    assert.equal(read.ok, false);
    assert.equal(read.error!.code, "FREECAD_NOT_INSTALLED", "the read passed the read-only gate and failed only for lack of FreeCAD");
    assert.deepEqual(read.error!.hints, ["run: npm run setup:freecad"]);
  });
});

test("the reviewer endpoint exposes part-dfm, a read that needs probe.run", async () => {
  await withProject(async (cwd) => {
    // Without a scoped reviewId the request fails at the reviewer's admission check, which only runs for exposed operations.
    const reviewed = await dispatchSidecarRequest("reviewer", cwd, reading[5] as never);
    assert.equal(reviewed.ok, false);
    assert.doesNotMatch(reviewed.error!.message, /reviewer endpoint does not expose operation/);
    assert.match(reviewed.error!.message, /missing its scoped reviewId/, "the operation passed the endpoint gate");
  });
});

test("the reviewer endpoint exposes no mutating part operation", async () => {
  await withProject(async (cwd) => {
    for (const request of mutating) {
      const denied = await dispatchSidecarRequest("reviewer", cwd, request as never);
      assert.equal(denied.ok, false);
      assert.match(denied.error!.message, /reviewer endpoint does not expose operation/, request.op);
    }
  });
});
