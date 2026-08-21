import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProjectStateStore } from "../src/shared/store.ts";
import { commitPlan, commitRequirements, route as routeQuick } from "../src/core/state-machine.ts";
import type { CadRequirements } from "../src/shared/protocol.ts";

test("tool_call policy blocks writes outside source_only and mutating bash in read_only", async () => {
  const quickRoute = {
  objective: "design",
  lineage: "greenfield",
  structure: "part",
  maturity: "prototype",
} as const;

const pi = {
    handlers: new Map<string, Function[]>(),
    on(event: string, handler: Function) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
    events: { emit() {}, on() {} },
    registerTool() {},
    registerCommand() {},
  };
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-policy-"));
  try {
    const store = new ProjectStateStore(cwd);
    await store.createRun({ runId: "policy-run" });
    const routed = routeQuick(null, quickRoute, "test");
    assert.ok(routed.ok);
    if (!routed.ok) return;
    const record: CadRequirements = {
      goal: "test",
      deliverables: ["STEP"],
      must: [],
      preferences: [],
      assumptions: [],
      openUnknowns: [],
        };
    const built = commitRequirements(routed.state, record);
    assert.ok(built.ok);
    if (!built.ok) return;
    await store.save({ ...routed.state, runId: "policy-run" });

    const toolCall = pi.handlers.get("tool_call")![0] as Function;
    const readOnlyBlock = (await toolCall(
      { toolName: "write", input: { path: "models/plate.py" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(readOnlyBlock.block, true);

    // source_only build phase allows model source writes but not harness-owned files.
    // (Fast path: requirements -> part_design -> build; the plan commit enters build.)
    const planned = commitPlan(built.state, {
      summary: "plan",
      protected: [],
      plannedChanges: [],
      interfaces: [],
      datums: [],
      reviewPlan: [],
    });
    assert.ok(planned.ok);
    if (!planned.ok) return;
    await store.save({ ...planned.state, runId: "policy-run" });
    const allowed = (await toolCall(
      { toolName: "write", input: { path: "models/plate.py" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.notEqual(allowed?.block, true);

    const blockedHarnessFile = (await toolCall(
      { toolName: "write", input: { path: ".pi-cad/state.json" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(blockedHarnessFile.block, true);

    // Review is read_only; mutating bash must be blocked as well.
    await store.save({ ...routed.state, phase: "review" as const, runId: "policy-run" });
    const readOnlyBashBlocked = (await toolCall(
      { toolName: "bash", input: { command: "cp model.py other.py" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(readOnlyBashBlocked.block, true);

    // read_only blocks ALL raw bash — pattern-based detection is incomplete
    // (python -c "open(...,'w')" matches no redirect rule), so the fence is
    // absolute; read-only computation goes through cad_probe_python.
    const readOnlyBenignBashBlocked = (await toolCall(
      { toolName: "bash", input: { command: "python3 -c \"print('hi')\"" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(readOnlyBenignBashBlocked.block, true);

    // The programmable probe is exposed exactly on the review-family phases.
    const { toolsForPhase } = await import("../src/core/policies.ts");
    for (const phase of ["review", "compare", "integration_review"] as const) {
      assert.ok(toolsForPhase(phase).includes("cad_probe_python"), `${phase} exposes cad_probe_python`);
    }
    for (const phase of ["build", "part_design", "requirements", "plan"] as const) {
      assert.ok(!toolsForPhase(phase).includes("cad_probe_python"), `${phase} must not expose cad_probe_python`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
