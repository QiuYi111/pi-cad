import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProjectStateStore } from "../src/shared/store.ts";
import { routeQuick } from "../src/workflows/quick.ts";

test("before_agent_start restores canonical state and active tool policy after restart", async () => {
  const pi = {
    tools: [] as string[],
    commands: [] as string[],
    handlers: new Map<string, Function[]>(),
    activeTools: [] as string[],
    registerTool(tool: { name: string }) {
      pi.tools.push(tool.name);
    },
    registerCommand(name: string) {
      pi.commands.push(name);
    },
    on(event: string, handler: Function) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    setActiveTools(names: string[]) {
      pi.activeTools = [...names];
    },
    appendEntry() {},
    sendUserMessage() {},
    events: { emit() {}, on() {} },
  };

  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-restore-"));
  try {
    const store = new ProjectStateStore(cwd);
    const routed = routeQuick(null, "quick", "fully specified plate");
    assert.ok(routed.ok);
    if (!routed.ok) return;
    await store.save(routed.state);
    await store.appendEvent("WorkflowRouted", { workflow: "quick" });

    const handler = pi.handlers.get("before_agent_start")![0] as Function;
    const result = (await handler(
      { systemPrompt: "BASE_PROMPT" },
      { cwd },
    )) as { systemPrompt?: string };
    assert.ok(result.systemPrompt);
    assert.match(result.systemPrompt!, /Pi-CAD invariants/);
    assert.match(result.systemPrompt!, /REQUIREMENTS/);
    assert.ok(pi.activeTools.includes("cad_commit_requirements"));
    assert.ok(!pi.activeTools.includes("edit"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
