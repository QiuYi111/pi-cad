import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProjectStateStore } from "../src/shared/store.ts";
import { commitRequirements, route as routeQuick } from "../src/core/state-machine.ts";
import type { CadRequirements } from "../src/shared/protocol.ts";

test("tool_call policy blocks writes outside source_only and mutating bash in read_only", async () => {
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
    const routed = routeQuick(null, "quick", "test");
    assert.ok(routed.ok);
    if (!routed.ok) return;
    const record: CadRequirements = {
      goal: "test",
      deliverables: ["STEP"],
      must: [],
      preferences: [],
      assumptions: [],
      openUnknowns: [],
      maturity: "prototype",
    };
    const built = commitRequirements(routed.state, record);
    assert.ok(built.ok);
    if (!built.ok) return;
    await store.save(routed.state);

    const toolCall = pi.handlers.get("tool_call")![0] as Function;
    const readOnlyBlock = (await toolCall(
      { toolName: "write", input: { path: "models/plate.py" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(readOnlyBlock.block, true);

    // source_only build phase allows model source writes but not harness-owned files.
    await store.save(built.state);
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
    await store.save({ ...routed.state, phase: "review" as const });
    const readOnlyBashBlocked = (await toolCall(
      { toolName: "bash", input: { command: "cp model.py other.py" } },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(readOnlyBashBlocked.block, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
