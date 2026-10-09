/**
 * `part-dfm` through the Agent API, against the fake FreeCAD worker. The worker's DFM
 * command is canned; geometry inspection and rendering are replaced through the part
 * hooks, so the test checks the handler's own work: the highlight, the images, the DFM
 * summary that export reads, and the authorization path.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../../../src/agent-api/handlers.ts";
import { partOpsHooks, readDfmSummary } from "../../../src/agent-api/part-ops.ts";
import { mechanicalRegistries } from "../../../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../../../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../../../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../../../src/harness/workflow/compiler.ts";
import { PartOpError, shutdownPartWorkers } from "../../../src/shared/freecad-worker.ts";

const fakeWorker = new URL("../../fixtures/freecad-fake-worker/worker.mjs", import.meta.url).pathname;
// The handler only base64-encodes what the renderer wrote, so any bytes stand in for a PNG here.
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const doc = "parts/bracket.FCStd";

type Calls = { artifact?: string; highlight?: unknown[]; annotations?: unknown[] };

function observeOnlyWorkflow() {
  return compileWorkflowDefinition({
    schema: 1, id: "test/part-dfm", version: "1.0.0", parametersSchema: {}, initialPhase: "inspect",
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

/** A project with a run started and the fake worker standing in for FreeCAD. */
async function withFakeFreecad(run: (cwd: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-part-dfm-fake-"));
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-part-dfm-canonical-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-part-dfm-"));
  const python = join(root, "bin", "python");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(python, `#!/bin/sh\nexec "${process.execPath}" "${fakeWorker}"\n`);
  await chmod(python, 0o755);
  const saved = {
    canonical: process.env.PI_CAD_CANONICAL_PROJECT_DIR,
    python: process.env.PI_CAD_FREECAD_PYTHON,
    kill: process.env.PI_CAD_PART_KILL_GRACE_S,
  };
  const hooks = { ...partOpsHooks };
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  process.env.PI_CAD_FREECAD_PYTHON = python;
  process.env.PI_CAD_PART_KILL_GRACE_S = "0.1";
  try {
    await new HarnessProjectStoreV7(cwd).startRun({ workflow: observeOnlyWorkflow(), registryContract: buildRegistryContract(mechanicalRegistries) });
    await run(cwd);
  } finally {
    shutdownPartWorkers();
    Object.assign(partOpsHooks, hooks);
    for (const [key, value] of [["PI_CAD_CANONICAL_PROJECT_DIR", saved.canonical], ["PI_CAD_FREECAD_PYTHON", saved.python], ["PI_CAD_PART_KILL_GRACE_S", saved.kill]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Replace geometry inspection and rendering. Face 1 sits at the error's centre; face 0 is elsewhere. */
function stubGeometryAndRender(calls: Calls): void {
  partOpsHooks.inspectGeometry = (async (_cwd: string, artifact: string) => {
    calls.artifact = artifact;
    return {
      ok: true,
      payload: {
        faceFingerprints: [
          { i: 0, type: "PLANE", c: [0, 0, 0], a: 1200 },
          { i: 1, type: "CYLINDER", c: [10, 10, 10], a: 3.1, r: 0.6 },
        ],
      },
    };
  }) as never;
  partOpsHooks.inspectVisual = (async (cwd: string, _artifact: string, outDir: string, options: { highlight?: unknown[]; annotations?: unknown[] }) => {
    calls.highlight = options.highlight;
    calls.annotations = options.annotations;
    await mkdir(join(cwd, outDir), { recursive: true });
    const path = join(cwd, outDir, "iso.png");
    await writeFile(path, PNG);
    return { ok: true, payload: { views: [{ name: "iso", path }] } };
  }) as never;
}

test("part-dfm: the report comes back with an image that highlights the error face", async () => {
  await withFakeFreecad(async (cwd) => {
    const calls: Calls = {};
    stubGeometryAndRender(calls);
    const result = await handleAgentApi(cwd, { schema: 1, op: "part-dfm", doc, layers: ["lint", "geometry"], budgetS: 12 }) as any;

    assert.equal(result.report.rulepack, "quanzhou.cnc_mill");
    assert.equal(result.report.issues[0].rule, "hole.min_diameter");
    assert.equal(result.report.counts.error, 1);
    assert.deepEqual(result.report.received, { args: { layers: ["lint", "geometry"] }, budgetS: 12 }, "layers and budget reach the worker");
    assert.equal(result.report.report_path, "build/dfm/rev-2.json");
    assert.deepEqual(result.images.map((image: any) => [image.name, image.mimeType]), [["iso", "image/png"]]);
    assert.equal(result.images[0].data, PNG.toString("base64"));
    assert.equal(result.highlighted, true);
    assert.equal(calls.artifact, "build/bracket.step", "the views are of the current STEP");
    assert.deepEqual(calls.highlight, [{ i: 1, type: "CYLINDER", c: [10, 10, 10], a: 3.1, r: 0.6 }], "the face at the issue centre is highlighted");
    assert.deepEqual(calls.annotations, [{ text: "hole.min_diameter", at: [10, 10, 12] }]);
  });
});

test("part-dfm records the summary export reads; no summary before a geometry run", async () => {
  await withFakeFreecad(async (cwd) => {
    assert.equal(await readDfmSummary(cwd, doc), null);
    stubGeometryAndRender({});
    await handleAgentApi(cwd, { schema: 1, op: "part-dfm", doc });
    const summary = await readDfmSummary(cwd, doc) as any;
    assert.deepEqual(summary.geometry, { state: "fresh", last_rev: 2 });
    assert.equal(summary.counts.error, 1);
    assert.equal(summary.rulepack, "quanzhou.cnc_mill");
    assert.equal("issues" in summary, false, "the export summary stays compact");
  });
});

test("part-dfm with lint only does not record a geometry run", async () => {
  await withFakeFreecad(async (cwd) => {
    stubGeometryAndRender({});
    await handleAgentApi(cwd, { schema: 1, op: "part-dfm", doc, layers: ["lint"] });
    assert.equal(await readDfmSummary(cwd, doc), null);
  });
});

test("part-dfm fails when the STEP cannot be inspected, instead of returning a report without its image", async () => {
  await withFakeFreecad(async (cwd) => {
    stubGeometryAndRender({});
    partOpsHooks.inspectGeometry = (async () => ({ ok: false, payload: { error: "no STEP at build/bracket.step" } })) as never;
    await assert.rejects(handleAgentApi(cwd, { schema: 1, op: "part-dfm", doc }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.message, "no STEP at build/bracket.step");
      return true;
    });
  });
});

test("part-dfm rejects a document path that is not an FCStd before the worker sees it", async () => {
  await withFakeFreecad(async (cwd) => {
    await assert.rejects(handleAgentApi(cwd, { schema: 1, op: "part-dfm", doc: "parts/bracket.step" }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.code, "BAD_REQUEST");
      return true;
    });
  });
});
