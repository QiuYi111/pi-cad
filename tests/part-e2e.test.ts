/**
 * End to end: FreeCAD part backend through the Agent API.
 * Needs the optional FreeCAD runtime (`npm run setup:freecad`, or
 * PI_CAD_FREECAD_PYTHON); skipped otherwise.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bootstrapAgentApiContracts } from "../src/agent-api/bootstrap.ts";
import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { PartOpError, resolveFreecadRuntime, shutdownPartWorkers } from "../src/shared/freecad-worker.ts";

let installed = true;
try { resolveFreecadRuntime(); } catch { installed = false; }

function buildWorkflow() {
  bootstrapAgentApiContracts();
  return compileWorkflowDefinition({
    schema: 1, id: "test/part-e2e", version: "1.0.0", parametersSchema: {}, initialPhase: "build",
    phases: {
      build: {
        purpose: "Build and revise a part", actions: ["cad_build_step", "transition"], grants: ["model_build", "observe", "observe_programmable", "transition"],
        writeScopes: ["project:deliverable"], recordObligations: [],
        evidenceObligations: [
          { ref: "candidate-visual", type: "visual", closeWith: "cad_build_step" },
          { ref: "candidate-geometry", type: "geometry", closeWith: "cad_build_step" },
        ], contextProviders: ["kernel.current-action"], hooks: [],
        transitions: { built: { target: "done", requiresPhaseObligations: true } },
      },
      done: { purpose: "Done", actions: [], grants: [], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    },
  }, mechanicalRegistries);
}

const doc = "parts/bracket.FCStd";
const base = [
  { op: "param", name: "hole_d", value: 6, unit: "mm" },
  { op: "sketch", name: "bracket/base_profile", plane: "XY", shapes: [{ rect: { center: [0, 0], size: [60, 30] } }] },
  { op: "pad", name: "bracket/base", sketch: "bracket/base_profile", length: 6 },
  { op: "sketch", name: "bracket/hole_profile", on: { feature: "bracket/base", role: "top" }, shapes: [{ circle: { center: [0, 0], diameter: "=hole_d" } }] },
  { op: "hole", name: "bracket/mount_hole", sketch: "bracket/hole_profile", diameter: "=hole_d", type: "through_all" },
];

test("FreeCAD part: open, build, edit one dimension, resolve the named hole", { skip: !installed && "FreeCAD runtime is not installed" }, async () => {
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-part-e2e-canonical-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-part-e2e-"));
  const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  try {
    const started = await new HarnessProjectStoreV7(cwd).startRun({ workflow: buildWorkflow(), registryContract: buildRegistryContract(mechanicalRegistries) });

    // Open an empty document: there is no geometry to show yet.
    const opened = await handleAgentApi(cwd, { schema: 1, op: "part-open", doc, create: true, body: "bracket" }) as any;
    assert.equal(opened.created, true);
    assert.deepEqual(opened.images, []);
    assert.equal(opened.artifact, null);

    // First build: seven views, evidence, no baseline.
    const first = await handleAgentApi(cwd, { schema: 1, op: "part-apply", doc, ops: base as never, message: "bracket" }) as any;
    assert.equal(first.images.length, 7);
    assert.deepEqual(first.images.map((image: any) => image.name), ["iso", "front", "back", "left", "right", "top", "bottom"]);
    assert.equal(first.changes.baseline, null);
    assert.equal(first.artifact.path, "build/bracket.step");
    assert.equal(first.part.rev, 1);
    assert.ok(existsSync(join(cwd, "build", "bracket.step.identity.json")), "FreeCAD output has an identity manifest");
    const afterFirst = await new HarnessRunStoreV7(cwd, started.state.runId).load(mechanicalRegistries);
    assert.equal(afterFirst?.state.artifacts["candidate:authoritative"]?.path, "build/bracket.step");
    assert.equal(afterFirst?.state.artifacts["candidate:source"]?.path, doc);
    assert.equal(afterFirst?.state.evidence.length, 2);

    // Edit one dimension: a smaller part, orange faces, and the hole is named.
    const second = await handleAgentApi(cwd, {
      schema: 1, op: "part-apply", doc, ops: [{ op: "param", name: "hole_d", value: 8 }] as never,
    }) as any;
    assert.equal(second.images.length, 7);
    assert.ok(second.changes.volumeMm3.delta < 0, `volume should shrink, got ${second.changes.volumeMm3.delta}`);
    assert.equal(second.highlighted, true);
    assert.ok(second.part.highlight.paths.some((path: string) => path.startsWith("bracket/mount_hole")));
    assert.deepEqual(second.changes.params.changed, { hole_d: [6, 8] });
    assert.ok(second.changes.features.recomputed.includes("bracket/hole_profile"));
    const afterSecond = await new HarnessRunStoreV7(cwd, started.state.runId).load(mechanicalRegistries);
    assert.equal(afterSecond?.state.staleEvidence.length, 2, "rebuilding revises the build evidence");

    // The semantic name works with the existing probe helpers.
    const resolved = await handleAgentApi(cwd, {
      schema: 1, op: "probe", preset: "python", subject: "current", purpose: "resolve the named hole",
      code: "selection = cad_resolve('bracket/mount_hole', kind='feature', expect='one')\nresult = {'radius': selection.object.radius}",
    }) as any;
    assert.ok(Math.abs(resolved.value.radius - 4) < 1e-4, `hole radius ${resolved.value.radius}`);

    // A trial changes nothing on disk or in run state.
    const before = await readFile(join(cwd, doc));
    const trial = await handleAgentApi(cwd, {
      schema: 1, op: "part-try", doc, ops: [{ op: "param", name: "hole_d", value: 12 }] as never,
    }) as any;
    assert.equal(trial.images.length, 7);
    assert.ok(trial.changes.volumeMm3.delta < 0);
    assert.deepEqual(await readFile(join(cwd, doc)), before);
    const afterTrial = await new HarnessRunStoreV7(cwd, started.state.runId).load(mechanicalRegistries);
    assert.equal(afterTrial?.state.artifacts["candidate:authoritative"]?.sha256, afterSecond?.state.artifacts["candidate:authoritative"]?.sha256);

    // A failing op rolls back and reports a structured error.
    await assert.rejects(
      handleAgentApi(cwd, {
        schema: 1, op: "part-apply", doc,
        ops: [{ op: "fillet", name: "bracket/too_round", edges: { feature: "bracket/base", role: "top_outer" }, radius: 40 }] as never,
      }),
      (error: unknown) => error instanceof PartOpError && error.code === "FILLET_FAILED" && error.rolledBack === true && (error.hints ?? []).includes("reduce radius"),
    );
    assert.deepEqual(await readFile(join(cwd, doc)), before);

    // Undo goes back to the previous revision and rebuilds it.
    const undone = await handleAgentApi(cwd, { schema: 1, op: "part-undo", doc }) as any;
    assert.equal(undone.part.rev, 1);
    assert.equal(undone.images.length, 7);
    assert.ok(undone.changes.volumeMm3.delta > 0, "undoing the wider hole adds volume back");
  } finally {
    shutdownPartWorkers();
    if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
  }
});
