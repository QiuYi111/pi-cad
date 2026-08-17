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
  const ctx = { cwd };
  try {
  // Generate the baseline STEP in-process with the Python fixture and cadctl,
  // then feed it to the workflow as the user-supplied STEP.
  const { execFileSync } = await import("node:child_process");
  execFileSync("python3", ["-m", "cadctl", "build", "--source", "/home/jingyi/pi-cad/tests/fixtures/plate.py", "--output", join(cwd, "plate.step")], {
    cwd,
    env: {
      ...process.env,
      PYTHONPATH: ["/home/jingyi/pi-cad/python", "/home/jingyi/pi-cad/.python/site-packages", process.env.PYTHONPATH ?? ""].filter(Boolean).join(":"),
    },
  });

  const route = pi.tools.get("cad_route");
  const req = pi.tools.get("cad_commit_requirements");
  const transition = pi.tools.get("cad_transition");
  const plan = pi.tools.get("cad_commit_plan");
  const candidate = pi.tools.get("cad_commit_candidate");
  const finish = pi.tools.get("cad_finish");

  const r1 = await route.execute("1", { workflow: "convert", reason: "format conversion to STL" }, undefined, undefined, ctx);
  assert.match(r1.content[0].text, /REQUIREMENTS/);
  const r2 = await req.execute("2", {
    goal: "convert plate.step to STL",
    deliverables: ["STL"],
    must: [],
    preferences: [],
    assumptions: ["STL intentionally has no hierarchy"],
    openUnknowns: [],
    maturity: "prototype",
    inputs: ["plate.step"],
  }, undefined, undefined, ctx);
  assert.match(r2.content[0].text, /SOURCE_BASELINE/);
  const r3 = await transition.execute("3", { event: "baseline_understood", note: "reviewed baseline" }, undefined, undefined, ctx);
  assert.match(r3.content[0].text, /TRANSFORM_PLAN/);
  const r4 = await plan.execute("4", { summary: "export STL sidecar", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] }, undefined, undefined, ctx);
  assert.match(r4.content[0].text, /CONVERT/);
  const r5 = await candidate.execute("5", { sources: ["plate.step"], label: "stl-sidecar", format: "stl", output: "plate.stl" }, undefined, undefined, ctx);
  assert.match(r5.content[0].text, /COMPARE/);
  assert.ok(existsSync(join(cwd, "plate.stl")));
  const state = JSON.parse(readFileSync(join(cwd, ".pi-cad", "state.json"), "utf-8"));
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
