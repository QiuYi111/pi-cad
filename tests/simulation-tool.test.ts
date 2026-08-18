import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";

interface MockPi {
  tools: Map<string, any>;
  registerTool(tool: { name: string }): void;
  registerCommand(): void;
  on(): void;
  setActiveTools(): void;
  appendEntry(): void;
  sendUserMessage(): void;
  setSessionName(): void;
  events: { emit(): void; on(): void };
}

function mockPi(): MockPi {
  const pi: MockPi = {
    tools: new Map(),
    registerTool(tool) {
      pi.tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
    setSessionName() {},
    events: { emit() {}, on() {} },
  };
  return pi;
}

test("cad_simulate takes structured arguments and canonicalizes the spec without an active run", async () => {
  const pi = mockPi();
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  simulation(pi as any);
  const tool = pi.tools.get("cad_simulate");
  assert.ok(tool, "cad_simulate is registered");

  // Structured interface: no spec path, no outputDir.
  const params = tool.parameters;
  const keys = Object.keys(params.properties);
  assert.ok(!keys.includes("spec"));
  assert.ok(!keys.includes("outputDir"));
  assert.ok(keys.includes("artifact"));
  assert.ok(keys.includes("materials"));
  assert.ok(keys.includes("loads"));
  assert.ok(keys.includes("constraints"));

  // The tool schema is strict: unknown keys (e.g. a "distribut" typo that
  // would silently fall back to the distribute default, or "dof" that would
  // silently over-constrain via the dofs default) must fail closed at the
  // tool boundary.
  assert.equal(params.additionalProperties, false);
  assert.equal(params.properties.physics.additionalProperties, false);
  assert.equal(params.properties.materials.items.additionalProperties, false);
  assert.equal(params.properties.mesh.additionalProperties, false);
  assert.equal(params.properties.constraints.items.additionalProperties, false);
  assert.equal(params.properties.loads.items.additionalProperties, false);

  const validLoad = {
    type: "nodal_force",
    region: { axis: "x", side: "max" },
    vector: [0, 0, -100.0],
  };
  assert.equal(Check(params.properties.loads.items, validLoad), true);
  assert.equal(
    Check(params.properties.loads.items, { ...validLoad, distribut: "per_node" }),
    false,
    "typo'd distribute key must be rejected",
  );
  const validConstraint = {
    type: "fixed",
    region: { axis: "x", side: "min" },
  };
  assert.equal(Check(params.properties.constraints.items, validConstraint), true);
  assert.equal(
    Check(params.properties.constraints.items, { ...validConstraint, dof: [2] }),
    false,
    "typo'd dofs key must be rejected (would default to [0,1,2])",
  );
  assert.equal(
    Check(params, {
      physics: { type: "linear_elasticity" },
      mesh: { element: "tet", size: 6.0, box: [60, 10, 10] },
      materials: [{ name: "steel", E: 210000.0, nu: 0.3 }],
      constraints: [validConstraint],
      loads: [validLoad],
      timestep: 0.1,
    }),
    false,
    "unknown top-level key must be rejected",
  );

  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-tool-"));
  try {
    const result = await tool.execute(
      "t1",
      {
        physics: { type: "linear_elasticity" },
        mesh: { element: "tet", size: 6.0, box: [60, 10, 10] },
        materials: [{ name: "steel", E: 210000.0, nu: 0.3 }],
        constraints: [{ type: "fixed", region: { axis: "x", side: "min" } }],
        loads: [{ type: "nodal_force", region: { axis: "x", side: "max" }, vector: [0, 0, -100.0] }],
      },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /cad_simulate solved/);
    assert.equal(result.details.kind, "simulation");
    assert.ok(result.details.specHash, "spec hash is surfaced for provenance");

    // Without an active workflow run the spec lands in the adhoc evidence root.
    const adhoc = join(cwd, ".pi-cad", "adhoc", "simulation");
    const dirs = await readdir(adhoc);
    assert.equal(dirs.length, 1);
    const written = JSON.parse(await readFile(join(adhoc, dirs[0], "spec.json"), "utf-8"));
    assert.equal(written.physics.type, "linear_elasticity");
    assert.equal(written.units, "mm_N_MPa");
    assert.equal(written.backend, "torch-fem");

    const envelope = result.details.envelope;
    assert.ok(envelope.ok);
    assert.equal(envelope.payload.status, "solved");
    const kinds = envelope.artifacts.map((a: any) => a.kind);
    assert.ok(kinds.includes("simulation_spec"));
    assert.ok(kinds.includes("simulation"));
    assert.ok(kinds.includes("simulation_fields"));
    assert.equal(kinds.filter((k: string) => k === "simulation_visual").length, 7);
    assert.equal(envelope.payload.visualization.views.length, 7);

    // artifact + mesh.box together are rejected before the backend runs;
    // otherwise the backend would mesh from the artifact and silently
    // ignore the box.
    const step = join(cwd, "plate.step");
    await writeFile(step, "stub-step", "utf-8");
    await assert.rejects(
      () =>
        tool.execute(
          "t2",
          {
            artifact: "plate.step",
            physics: { type: "linear_elasticity" },
            mesh: { element: "tet", size: 6.0, box: [60, 10, 10] },
            materials: [{ name: "steel", E: 210000.0, nu: 0.3 }],
            constraints: [{ type: "fixed", region: { axis: "x", side: "min" } }],
            loads: [{ type: "nodal_force", region: { axis: "x", side: "max" }, vector: [0, 0, -100.0] }],
          },
          undefined,
          undefined,
          { cwd },
        ),
      /not both/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
