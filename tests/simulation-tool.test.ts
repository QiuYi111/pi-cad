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

test("structural FEA accepts a fused analysis model via derivationRef and binds evidence to the canonical design", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const venvPython = join(fileURLToPath(new URL("..", import.meta.url)), ".venv", "bin", "python");
  if (!existsSync(venvPython)) return; // honest skip: backend not set up
  const root = fileURLToPath(new URL("..", import.meta.url));

  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-structural-derivation-"));
  try {
    // A two-part assembly whose solids touch — the canonical design.
    await writeFile(
      join(cwd, "assembly.py"),
      [
        "import build123d as bd",
        "with bd.BuildPart() as p:",
        "    bd.Box(60, 20, 10, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))",
        "    a = p.part",
        "with bd.BuildPart() as p:",
        "    bd.Box(20, 20, 30, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MAX))",
        "    b = p.part",
        "result = bd.Compound([a, b])",
        "",
      ].join("\n"),
    );
    const env = { ...process.env, PYTHONPATH: join(root, "python") };
    execFileSync(venvPython, ["-m", "cadctl", "build", "--source", "assembly.py", "--output", "assembly.step", "--force"], {
      cwd, encoding: "utf-8", env, timeout: 300_000,
    });

    // Make the canonical design the project head so the guard protects it.
    const { CadProjectStore } = await import("../src/shared/store.ts");
    const { createHash } = await import("node:crypto");
    const { readFile: rf } = await import("node:fs/promises");
    const store = new CadProjectStore(cwd);
    const project = await store.ensureProject();
    await store.updateHead({
      artifactPath: "assembly.step",
      artifactHash: createHash("sha256").update(await rf(join(cwd, "assembly.step"))).digest("hex"),
      evidence: project.head.evidence,
    });

    const pi = mockPi();
    const simulation = (await import("../src/extensions/simulation/index.ts")).default;
    simulation(pi as any);
    const deriveTool = pi.tools.get("cad_derive_analysis_model");
    const simulateTool = pi.tools.get("cad_simulate");

    // 1. Harness-executed derivation: fuse the assembly for solid FEA.
    const derived = await deriveTool.execute(
      "d1",
      { source: "assembly.step", operations: ["fused"] },
      undefined, undefined, { cwd },
    );
    const derivedText = derived.content[0].type === "text" ? derived.content[0].text : "";
    assert.match(derivedText, /harness-executed/);
    const payload = derived.details.envelope.payload as {
      recordPath: string;
      output: string;
    };
    assert.ok(existsSync(payload.output));
    assert.ok(existsSync(payload.recordPath));
    const record = JSON.parse(await rf(payload.recordPath, "utf-8"));
    assert.equal(record.executed, true);

    // 2. FEA on the fused model WITHOUT the declaration: fail closed.
    const rejected = await simulateTool.execute(
      "s0",
      {
        artifact: payload.output,
        physics: { type: "linear_elasticity" },
        mesh: { element: "tet", size: 6.0 },
        materials: [{ name: "steel", E: 210000.0, nu: 0.3 }],
        constraints: [{ type: "fixed", region: { axis: "x", side: "min" } }],
        loads: [{ type: "nodal_force", region: { axis: "x", side: "max" }, vector: [0, 0, -100.0] }],
      } as never,
      undefined, undefined, { cwd },
    ).catch((error: Error) => error);
    const rejectedText =
      rejected instanceof Error ? rejected.message : rejected.content[0].text;
    assert.match(rejectedText, /analysisModel/);

    // 3. WITH the derivationRef: the run executes, and the evidence binds
    // to the CANONICAL assembly hash — the original fuse-for-FEA use case.
    const solved = await simulateTool.execute(
      "s1",
      {
        artifact: payload.output,
        analysisModel: { derivationRef: payload.recordPath },
        physics: { type: "linear_elasticity" },
        mesh: { element: "tet", size: 6.0 },
        materials: [{ name: "steel", E: 210000.0, nu: 0.3 }],
        constraints: [{ type: "fixed", region: { axis: "x", side: "min" } }],
        loads: [{ type: "nodal_force", region: { axis: "x", side: "max" }, vector: [0, 0, -100.0] }],
      } as never,
      undefined, undefined, { cwd },
    );
    const solvedText = solved.content[0].type === "text" ? solved.content[0].text : "";
    assert.match(solvedText, /cad_simulate solved/);
    const canonicalHash = record.sourceHash;
    assert.equal(solved.details.artifactHash, canonicalHash);
    // The envelope carries the frozen derivation chain as inputArtifacts.
    const roles = (solved.details.envelope.inputArtifacts ?? []).map((entry: { role: string }) => entry.role);
    assert.ok(roles.includes("derivationRecord"), `roles: ${roles.join(",")}`);
    assert.ok(roles.includes("analysisSource"), `roles: ${roles.join(",")}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
