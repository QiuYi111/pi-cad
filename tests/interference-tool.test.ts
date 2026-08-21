import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

type ToolDef = {
  name: string;
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string; [key: string]: unknown },
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: any }>;
};

function mockPi() {
  const pi: any = {
    tools: new Map<string, ToolDef>(),
    activeTools: [] as string[],
    events: { emit() {}, on() {} },
    registerTool(tool: ToolDef) {
      pi.tools.set(tool.name, tool);
    },
    on() {},
    registerCommand() {},
    setActiveTools(names: string[]) {
      pi.activeTools = [...names];
    },
    getActiveTools: () => [...pi.activeTools],
    getAllTools: () => [] as unknown[],
    appendEntry() {},
    sendUserMessage() {},
  };
  return pi;
}

// Two overlapping boxes: the harness auto-observes interference facts at
// candidate commit, and integration review cannot accept without them.
const OVERLAPPING_ASSEMBLY = `
import build123d as bd

with bd.BuildPart() as p:
    bd.Box(20, 20, 20)
    a = p.part
with bd.BuildPart() as p:
    bd.Box(20, 20, 20)
    b = p.part

result = bd.Compound([a, b.moved(bd.Location((10, 0, 0)))])
`;

test("assembly candidate auto-records interference evidence and gates integration review", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-interference-"));
  try {
    const ctx = { cwd };
    const route = pi.tools.get("cad_route")!;
    const requirements = pi.tools.get("cad_commit_requirements")!;
    const assemblyDesign = pi.tools.get("cad_commit_assembly_design")!;
    const contracts = pi.tools.get("cad_commit_interface_contracts")!;
    const plan = pi.tools.get("cad_commit_plan")!;
    const candidate = pi.tools.get("cad_commit_candidate")!;
    const transition = pi.tools.get("cad_transition")!;

    let r = await route.execute(
      "t1",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "assembly",
        maturity: "engineering",
        reason: "two overlapping boxes on purpose",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(r.details.state);

    r = await requirements.execute(
      "t2",
      {
        goal: "assembly with one deliberate overlap",
        deliverables: ["STEP"],
        must: [],
        assertions: [],
        preferences: [],
        assumptions: [],
        openUnknowns: [],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(r.content[0].text!, /SYSTEM CONCEPT/);

    r = await transition.execute("t3", { event: "direction_selected", note: "two boxes" }, undefined, undefined, ctx);
    assert.match(r.content[0].text!, /ASSEMBLY DESIGN/);

    r = await assemblyDesign.execute(
      "t4",
      {
        summary: "two overlapping boxes",
        modules: [
          { name: "a", purpose: "base" },
          { name: "b", purpose: "moved copy" },
        ],
        datums: [{ name: "A", kind: "primary", definedBy: "bottom of a" }],
        sequence: [{ step: 1, installs: ["a"] }, { step: 2, installs: ["b"] }],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(r.content[0].text!, /INTERFACE DESIGN/);

    r = await contracts.execute(
      "t5",
      {
        contracts: [
          {
            id: "a-b",
            a: "a",
            b: "b",
            purpose: "overlap deliberately",
            locating: "shared volume",
            dof: "none",
            fasteners: "none",
            fits: "interference",
            assemblyDirection: "+X",
            toolAccess: "n/a",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(r.content[0].text!, /PART DESIGN/);

    r = await plan.execute(
      "t6",
      { summary: "boxes", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(r.content[0].text!, /BUILD/);

    mkdirSync(join(cwd, "models"), { recursive: true });
    writeFileSync(join(cwd, "models", "assembly.py"), OVERLAPPING_ASSEMBLY);

    r = await candidate.execute("t7", { sources: ["models/assembly.py"], label: "c1" }, undefined, undefined, ctx);
    assert.match(r.content[0].text!, /interference/);
    const state = JSON.parse(
      readFileSync(join(cwd, ".pi-cad", "runs", r.details.state.runId, "state.json"), "utf-8"),
    );
    const interference = state.evidence.filter((e: { kind: string }) => e.kind === "interference");
    assert.equal(interference.length, 1);
    assert.equal(state.evidence.filter((e: { kind: string }) => e.kind === "assembly").length, 1);
    assert.equal(state.phase, "integration_review");

    // The observed pair is the deliberate overlap: a fact, not a verdict.
    const evidenceFile = interference[0].paths[0];
    const evidenceAbs = evidenceFile.startsWith("/") ? evidenceFile : join(cwd, evidenceFile);
    const payload = JSON.parse(readFileSync(evidenceAbs, "utf-8"));
    assert.equal(payload.pairs.length, 1);
    assert.equal(payload.pairs[0].classification, "penetration");
    assert_almost_equal(payload.pairs[0].intersectionVolume, 4000, 1);

    // Accepted is possible with the full evidence set (the Agent interprets
    // the penetration as intentional; the harness only checks presence).
    const accepted = await transition.execute("t8", { event: "accepted", note: "overlap is deliberate" }, undefined, undefined, ctx);
    assert.match(accepted.content[0].text!, /READY/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("new assembly candidate stales the previous interference evidence", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-interference-stale-"));
  try {
    const ctx = { cwd };
    const { route: routeTool } = { route: pi.tools.get("cad_route")! };
    await routeTool.execute(
      "s1",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "assembly",
        maturity: "engineering",
        reason: "stale check",
      },
      undefined,
      undefined,
      ctx,
    );
    const state0 = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", await currentRunId(cwd), "state.json"), "utf-8"));
    // Fabricate a prior candidate + evidence, then commit a new candidate:
    // markEvidenceStale must move interference evidence to staleEvidence.
    const { markEvidenceStale } = await import("../src/core/state-machine.ts");
    const fabricated = {
      ...state0,
      phase: "build",
      currentArtifactHash: "old",
      evidence: [
        {
          id: "interference-1",
          kind: "interference",
          tool: "cad_inspect_interference",
          artifactHash: "old",
          paths: ["evidence/interference/old.json"],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const staled = markEvidenceStale(fabricated);
    assert.equal(staled.evidence.length, 0);
    assert.equal(staled.staleEvidence.length, 1);
    assert.equal(staled.staleEvidence[0].kind, "interference");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function currentRunId(cwd: string): Promise<string> {
  const project = JSON.parse(readFileSync(join(cwd, ".pi-cad", "project.json"), "utf-8"));
  return project.currentRunId;
}

function assert_almost_equal(actual: number, expected: number, tol: number) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ~${expected}, got ${actual}`,
  );
}

test("cad_scan_sections reports area/moment facts for a box", async () => {
  const { execFileSync } = await import("node:child_process");
  const venvPython = join(cwdRoot(), ".venv", "bin", "python");
  let blenderless = true;
  try {
    execFileSync("blender", ["--version"], { encoding: "utf-8" });
  } catch {
    blenderless = false;
  }
  if (!existsSyncLocal(venvPython)) return;
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-sections-"));
  try {
    writeFileSync(
      join(cwd, "box.py"),
      [
        "import build123d as bd",
        "with bd.BuildPart() as p:",
        "    bd.Box(40, 30, 12)",
        "result = p.part",
        "",
      ].join("\n"),
    );
    execFileSync(venvPython, ["-m", "cadctl", "build", "--source", "box.py", "--output", "box.step", "--force"], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, PYTHONPATH: join(cwdRoot(), "python") },
    });
    const pi = mockPi();
    const geometry = (await import("../src/extensions/geometry/index.ts")).default;
    geometry(pi as never);
    const tool = pi.tools.get("cad_scan_sections");
    const bad = await tool.execute("s0", { artifact: "box.step", axis: "z" }, undefined, undefined, { cwd });
    assert.match(bad.content[0].text as string, /exactly one of count or step/);

    const result = await tool.execute(
      "s1",
      { artifact: "box.step", axis: "z", count: 3 },
      undefined,
      undefined,
      { cwd },
    );
    assert.match(result.content[0].text as string, /3 sections along Z/);
    assert.match(result.content[0].text as string, /critical section is your judgment/);
    const payload = result.details.envelope.payload as {
      sections: Array<{ totalArea: number; faces: Array<{ Iu: number; Iv: number }> }>;
    };
    assert_almost_equal(payload.sections[0].totalArea, 1200, 1e-6);
    assert_almost_equal(payload.sections[0].faces[0].Iu, 90000, 1e-6);
    assert_almost_equal(payload.sections[0].faces[0].Iv, 160000, 1e-6);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function cwdRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function existsSyncLocal(path: string): boolean {
  return existsSync(path);
}
