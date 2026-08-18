import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
