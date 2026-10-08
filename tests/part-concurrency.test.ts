/**
 * FreeCAD part backend: concurrent requests for different documents must never
 * mix documents up (the agent runs `asyncio.gather(doc.apply(...))` over several
 * parts). Needs the optional FreeCAD runtime; skipped otherwise.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bootstrapAgentApiContracts } from "../src/agent-api/bootstrap.ts";
import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { PartOpError, resolveFreecadRuntime, shutdownPartWorkers } from "../src/shared/freecad-worker.ts";

let installed = true;
try { resolveFreecadRuntime(); } catch { installed = false; }

function buildWorkflow() {
  bootstrapAgentApiContracts();
  return compileWorkflowDefinition({
    schema: 1, id: "test/part-concurrency", version: "1.0.0", parametersSchema: {}, initialPhase: "build",
    phases: {
      build: {
        purpose: "Build parts", actions: ["cad_build_step", "transition"], grants: ["model_build", "observe", "observe_programmable", "transition"],
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

const names = ["motor", "battery_door", "roller_screw", "chassis", "gear", "axle"];
/** Every document gets a different footprint and thickness so a mix-up is visible. */
const sizes: Record<string, [number, number, number]> = {
  motor: [30, 20, 10], battery_door: [52, 31, 1.6], roller_screw: [8, 8, 40], chassis: [100, 60, 4], gear: [25, 25, 5], axle: [4, 4, 70],
};
const plate = (name: string) => {
  const [x, y, z] = sizes[name]!;
  return [
    { op: "sketch", name: `${name}/profile`, plane: "XY", shapes: [{ rect: { center: [0, 0], size: [x, y] } }] },
    { op: "pad", name: `${name}/body`, sketch: `${name}/profile`, length: z },
  ];
};

test("FreeCAD part: a concurrent batch over several documents keeps every document isolated", { skip: !installed && "FreeCAD runtime is not installed" }, async () => {
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-part-conc-canonical-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-part-conc-"));
  const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  try {
    await new HarnessProjectStoreV7(cwd).startRun({ workflow: buildWorkflow(), registryContract: buildRegistryContract(mechanicalRegistries) });
    const docOf = (name: string) => `parts/${name}.FCStd`;

    // Concurrent create + open.
    await Promise.all(names.map((name) => handleAgentApi(cwd, { schema: 1, op: "part-open", doc: docOf(name), create: true, body: name })));
    // Concurrent apply: the failing pattern from the rollout.
    const results = await Promise.all(names.map((name) =>
      handleAgentApi(cwd, { schema: 1, op: "part-apply", doc: docOf(name), ops: plate(name) as never, message: `build ${name}` }),
    )) as any[];

    const volumeOf = (name: string) => sizes[name]!.reduce((a, b) => a * b, 1);
    names.forEach((name, index) => {
      const result = results[index];
      assert.equal(result.artifact.path, `build/${name}.step`);
      assert.equal(result.part.rev, 1, name);
      assert.ok(Math.abs(result.changes.volumeMm3.after - volumeOf(name)) < 1e-3, `${name}: volume ${result.changes.volumeMm3.after}`);
    });

    // A second concurrent round mixing reads and writes.
    const round = await Promise.all(names.flatMap((name) => [
      handleAgentApi(cwd, { schema: 1, op: "part-apply", doc: docOf(name), ops: [{ op: "set", target: `${name}/body`, prop: "Length", value: sizes[name]![2] * 2 }] as never }),
      handleAgentApi(cwd, { schema: 1, op: "part-tree", doc: docOf(name) }),
    ])) as any[];
    names.forEach((name, index) => {
      assert.ok(Math.abs(round[index * 2].changes.volumeMm3.after - 2 * volumeOf(name)) < 1e-3, `${name} second round`);
      assert.equal(round[index * 2].artifact.path, `build/${name}.step`);
    });

    // From disk, after a worker restart, every document still holds its own geometry.
    shutdownPartWorkers();
    const trees = await Promise.all(names.map((name) => handleAgentApi(cwd, { schema: 1, op: "part-tree", doc: docOf(name) }))) as any[];
    names.forEach((name, index) => {
      const tree = trees[index];
      assert.equal(tree.rev, 2, name);
      const objects = tree.bodies[0].objects as Array<{ path: string; params?: { Length?: number } }>;
      assert.deepEqual(objects.map((item) => item.path), [`${name}/profile`, `${name}/body`], name);
      assert.equal(objects[1]!.params?.Length, sizes[name]![2] * 2, name);
    });
  } finally {
    shutdownPartWorkers();
    if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
  }
});

test("FreeCAD part: failures and a worker restart inside a concurrent batch hurt only their own document; undo never empties a part by accident", { skip: !installed && "FreeCAD runtime is not installed" }, async () => {
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-part-conc2-canonical-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-part-conc2-"));
  const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  try {
    await new HarnessProjectStoreV7(cwd).startRun({ workflow: buildWorkflow(), registryContract: buildRegistryContract(mechanicalRegistries) });
    const batch = ["motor", "gear", "axle", "chassis"];
    const docOf = (name: string) => `parts/${name}.FCStd`;
    await Promise.all(batch.map((name) => handleAgentApi(cwd, { schema: 1, op: "part-open", doc: docOf(name), create: true, body: name })));

    // gear fails (fillet too large), axle outlives its budget (the worker is killed and restarted), the others succeed.
    process.env.PI_CAD_PART_KILL_GRACE_S = "0.2";
    const settled = await Promise.allSettled(batch.map((name) => {
      if (name === "gear") {
        return handleAgentApi(cwd, { schema: 1, op: "part-apply", doc: docOf(name), ops: [
          ...plate(name),
          { op: "fillet", name: `${name}/too_round`, edges: { feature: `${name}/body`, role: "top_outer" }, radius: 500 },
        ] as never });
      }
      if (name === "axle") {
        return handleAgentApi(cwd, { schema: 1, op: "part-apply", doc: docOf(name), budgetS: 1, ops: [
          ...plate(name),
          { op: "linear_pattern", name: `${name}/row`, features: [`${name}/body`], direction: "X", length: 25, count: 4000 },
        ] as never });
      }
      return handleAgentApi(cwd, { schema: 1, op: "part-apply", doc: docOf(name), ops: plate(name) as never });
    }));
    delete process.env.PI_CAD_PART_KILL_GRACE_S;

    const [motor, gear, axle, chassis] = settled;
    assert.equal(gear!.status, "rejected");
    const gearError = (gear as PromiseRejectedResult).reason as PartOpError;
    assert.equal(gearError.code, "FILLET_FAILED");
    assert.equal(gearError.rolledBack, true);
    assert.match(gearError.message, /revision 0/);
    assert.match(gearError.message, /Do NOT call undo/);
    assert.equal(axle!.status, "rejected");
    assert.equal(((axle as PromiseRejectedResult).reason as PartOpError).code, "BUDGET_EXCEEDED");
    for (const [name, outcome] of [["motor", motor], ["chassis", chassis]] as const) {
      assert.equal(outcome!.status, "fulfilled", name);
      const value = (outcome as PromiseFulfilledResult<any>).value;
      assert.ok(Math.abs(value.changes.volumeMm3.after - sizes[name]!.reduce((a, b) => a * b, 1)) < 1e-3, `${name} volume`);
    }

    // After the restart every document is at the right revision with the right content.
    const trees = await Promise.all(batch.map((name) => handleAgentApi(cwd, { schema: 1, op: "part-tree", doc: docOf(name) }))) as any[];
    assert.deepEqual(trees.map((tree) => tree.rev), [1, 0, 0, 1]);
    assert.deepEqual(trees[0].bodies[0].objects.map((item: any) => item.path), ["motor/profile", "motor/body"]);
    assert.deepEqual(trees[3].bodies[0].objects.map((item: any) => item.path), ["chassis/profile", "chassis/body"]);
    assert.deepEqual(trees[1].bodies[0].objects, []);

    // Undo of the only revision needs an explicit argument.
    await assert.rejects(
      handleAgentApi(cwd, { schema: 1, op: "part-undo", doc: docOf("motor") }),
      (error: unknown) => error instanceof PartOpError && error.code === "UNDO_WOULD_EMPTY",
    );
    assert.equal(((await handleAgentApi(cwd, { schema: 1, op: "part-tree", doc: docOf("motor") })) as any).rev, 1);
    const emptied = await handleAgentApi(cwd, { schema: 1, op: "part-undo", doc: docOf("motor"), toEmpty: true }) as any;
    assert.equal(emptied.part.rev, 0);
  } finally {
    delete process.env.PI_CAD_PART_KILL_GRACE_S;
    shutdownPartWorkers();
    if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
  }
});
