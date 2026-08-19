import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface MockPi {
  tools: Map<string, any>;
  activeTools: string[];
  events: { emit(): void };
  registerTool(tool: { name: string }): void;
  on(_event: string, _handler: unknown): void;
  registerCommand(_name: string, _options: unknown): void;
  setActiveTools(names: string[]): void;
  appendEntry(): void;
  sendUserMessage(): void;
}

function mockPi(): MockPi {
  const pi: MockPi = {
    tools: new Map(),
    activeTools: [],
    events: { emit() {} },
    registerTool(tool) { pi.tools.set(tool.name, tool); },
    on() {},
    registerCommand() {},
    setActiveTools(names) { pi.activeTools = [...names]; },
    getActiveTools(): string[] { return [...pi.activeTools]; },
    getAllTools() { return []; },
    appendEntry() {},
    sendUserMessage() {},
  };
  return pi;
}

test("convert workflow accepts a STEP source and produces an STL sidecar", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-convert-"));
  const { CadProjectStore } = await import("../src/shared/store.ts");
  const project = new CadProjectStore(cwd);
  await project.createRun({ runId: "convert-run" });
  const ctx = { cwd };
  try {
  // Generate the baseline STEP in-process with the Python fixture and cadctl,
  // then feed it to the workflow as the user-supplied STEP. Spawn through the
  // same Python resolution the harness itself uses (venv when present) so the
  // test passes on fresh installs and CI, not only on a dev checkout.
  const { execFileSync } = await import("node:child_process");
  const { cadctlEnv, pythonBinary } = await import("../src/shared/capability.ts");
  const repoRoot = process.cwd();
  execFileSync(pythonBinary(), ["-m", "cadctl", "build", "--source", join(repoRoot, "tests", "fixtures", "plate.py"), "--output", join(cwd, "plate.step")], {
    cwd,
    env: cadctlEnv(),
  });

  const route = pi.tools.get("cad_route");
  const req = pi.tools.get("cad_commit_requirements");
  const frameContext = pi.tools.get("cad_commit_frame_context");
  const transition = pi.tools.get("cad_transition");
  const plan = pi.tools.get("cad_commit_plan");
  const candidate = pi.tools.get("cad_commit_candidate");
  const finish = pi.tools.get("cad_finish");

  const r1 = await route.execute("1", { objective: "convert", reason: "format conversion to STL" }, undefined, undefined, ctx);
  assert.match(r1.content[0].text, /REQUIREMENTS/);
  const r2 = await req.execute("2", {
    goal: "convert plate.step to STL",
    deliverables: ["STL"],
    must: [],
    preferences: [],
    assumptions: ["STL intentionally has no hierarchy"],
    openUnknowns: [],
    inputs: ["plate.step"],
  }, undefined, undefined, ctx);
  assert.match(r2.content[0].text, /SOURCE_BASELINE/);
  // Frame context is mandatory before leaving the source baseline.
  const blocked = await transition.execute("2b", { event: "baseline_understood", note: "skipped frame check" }, undefined, undefined, ctx);
  assert.match(blocked.content[0].text, /frame_context/);
  const r2c = await frameContext.execute("2c", {
    axes: [
      { axis: "x", mapsTo: "long edge direction" },
      { axis: "y", mapsTo: "short edge direction" },
      { axis: "z", mapsTo: "plate normal, up" },
    ],
    howConfirmed: "user confirmed the long edge runs along X in their fixture",
  }, undefined, undefined, ctx);
  assert.match(r2c.content[0].text, /SOURCE_BASELINE/);
  const r3 = await transition.execute("3", { event: "baseline_understood", note: "reviewed baseline; frame confirmed" }, undefined, undefined, ctx);
  assert.match(r3.content[0].text, /TRANSFORM_PLAN/);
  const r4 = await plan.execute("4", { summary: "export STL sidecar", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] }, undefined, undefined, ctx);
  assert.match(r4.content[0].text, /CONVERT/);
  const r5 = await candidate.execute("5", { sources: ["plate.step"], label: "stl-sidecar", format: "stl", output: "plate.stl" }, undefined, undefined, ctx);
  assert.match(r5.content[0].text, /COMPARE/);
  assert.ok(existsSync(join(cwd, "plate.stl")));
  const state = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", "convert-run", "state.json"), "utf-8"));
  assert.equal(state.phase, "compare");
  assert.ok(state.evidence.some((e: { kind: string }) => e.kind === "convert"));
  const r6 = await transition.execute("6", { event: "accepted", note: "STL sidecar exported; hierarchy intentionally baked" }, undefined, undefined, ctx);
  assert.match(r6.content[0].text, /READY/);
  const r7 = await finish.execute("7", {}, undefined, undefined, ctx);
  assert.match(r7.content[0].text, /finished/);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
});
