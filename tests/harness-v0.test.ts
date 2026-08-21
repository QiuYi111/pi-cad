import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface MockPi {
  tools: Map<string, ToolDef>;
  activeTools: string[];
  events: { emit(): void };
  registerTool(tool: ToolDef): void;
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
    registerTool(tool) {
      pi.tools.set(tool.name, tool);
    },
    on() {},
    registerCommand() {},
    setActiveTools(names) {
      pi.activeTools = [...names];
    },
    getActiveTools(): string[] {
      return [...pi.activeTools];
    },
    getAllTools() {
      return [];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  return pi;
}

test("V0 walking skeleton: plate task runs route -> requirements -> candidate -> review -> ready -> done", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-harness-"));
  const project = new (await import("../src/shared/store.ts")).CadProjectStore(cwd);
  await project.createRun({ runId: "v0-run" });
  const ctx = { cwd } as { cwd: string };
  const fixture = readFileSync(new URL("./fixtures/plate.py", import.meta.url), "utf-8");
  try {
    const route = pi.tools.get("cad_route")!;
    const requirements = pi.tools.get("cad_commit_requirements")!;
    const candidate = pi.tools.get("cad_commit_candidate")!;
    const transition = pi.tools.get("cad_transition")!;
    const finish = pi.tools.get("cad_finish")!;

    const routed = await route.execute(
      "t1",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "part",
        maturity: "prototype",
        reason: "fully specified plate",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(routed.content[0].text!, /REQUIREMENTS/);

    const committed = await requirements.execute(
      "t2",
      {
        goal: "100 x 80 x 5 mm plate with four 6 mm holes 10 mm from edges",
        deliverables: ["STEP", "source"],
        must: ["100 x 80 x 5", "4 x 6 mm through holes"],
        assertions: [
          { id: "A-size", mustRef: "M1", statement: "Overall dimensions are 100 x 80 x 5 mm", binding: { subject: "plate", quantity: "overall dimensions" }, expectation: { kind: "relation", description: "bbox dimensions are 100 x 80 x 5 mm" } },
          { id: "A-holes", mustRef: "M2", statement: "Plate has four 6 mm through holes", binding: { subject: "mounting holes", quantity: "count, diameter, and through condition" }, expectation: { kind: "relation", description: "four through holes of diameter 6 mm" } },
        ],
        preferences: [],
        assumptions: [],
        openUnknowns: [],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(committed.content[0].text!, /PART DESIGN/);

    // Fast path: part_design is the plan phase; committing the plan enters build.
    const plan = pi.tools.get("cad_commit_plan")!;
    const planned = await plan.execute(
      "t2b",
      { summary: "plate plan", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(planned.content[0].text!, /BUILD/);

    mkdirSync(join(cwd, "models"), { recursive: true });
    writeFileSync(join(cwd, "models", "plate.py"), fixture);

    const committedCandidate = await candidate.execute(
      "t3",
      { sources: ["models/plate.py"], label: "candidate-v1" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(committedCandidate.content[0].text!, /REVIEW/);
    assert.equal(committedCandidate.content.filter((part) => part.type === "image").length, 7);

    const statePath = join(cwd, ".pi-cad", "runs", "v0-run", "state.json");
    assert.ok(existsSync(statePath));
    const reviewState = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(reviewState.phase, "review");
    assert.equal(reviewState.evidence.length, 3);
    assert.ok(reviewState.currentSourceHash);
    assert.ok(reviewState.currentArtifactHash);
    assert.ok(existsSync(join(cwd, "build", "plate.step")));
    assert.ok(existsSync(join(cwd, ".pi-cad", "runs", "v0-run", "records", "requirements.json")));
    assert.ok(existsSync(join(cwd, ".pi-cad", "runs", "v0-run", "events.jsonl")));

    const prematureFinish = await finish.execute("t4", {}, undefined, undefined, ctx);
    assert.match(prematureFinish.content[0].text!, /only valid in ready/);

    const illegalRoute = await route.execute(
      "t5",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "part",
        maturity: "prototype",
        reason: "trying to re-route from review",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(illegalRoute.content[0].text!, /only valid from intake/);

    const visualPath = reviewState.evidence.find((ref: { kind: string }) => ref.kind === "visual").paths[0];
    const hiddenPath = `${visualPath}.hidden`;
    renameSync(visualPath, hiddenPath);
    const blockedByMissingEvidence = await transition.execute(
      "t6",
      { event: "accepted", note: "trying before evidence is restored" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(blockedByMissingEvidence.content[0].text!, /files are missing/);
    renameSync(hiddenPath, visualPath);

    const accepted = await transition.execute(
      "t7",
      { event: "accepted", note: "reviewed all seven views and measured hole facts" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(accepted.content[0].text!, /READY/);

    const finished = await finish.execute("t8", {}, undefined, undefined, ctx);
    assert.match(finished.content[0].text!, /finished/);

    const doneState = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(doneState.phase, "done");
    assert.equal(doneState.status, "done");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
