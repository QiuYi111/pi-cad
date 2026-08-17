import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CadProjectStore } from "../src/shared/store.ts";
import { createIntakeState } from "../src/core/state-machine.ts";

function mockPi() {
  const pi: any = {
    commands: new Map(),
    handlers: new Map(),
    sent: [] as string[],
    activeTools: [] as string[],
    registerTool() {},
    registerCommand(name: string, options: any) { pi.commands.set(name, options); },
    on(event: string, handler: any) { pi.handlers.set(event, handler); },
    setActiveTools(names: string[]) { pi.activeTools = [...names]; },
    appendEntry() {},
    sendUserMessage(text: string) { pi.sent.push(text); },
    events: { emit() {}, on() {} },
    getAllTools() { return []; },
  };
  return pi;
}

test("/cad is an IDLE display command and cad_route creates runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-idle-"));
  const pi = mockPi();
  try {
    const runtime = (await import("../src/core/runtime.ts")).default;
    runtime(pi);
    const ctx = { cwd, hasUI: true, ui: { notify() {} } } as any;
    const store = new CadProjectStore(cwd);

    await pi.commands.get("cad").handler("", ctx);
    const project = await store.loadProject();
    assert.ok(project);
    assert.equal(project.currentRunId, null);

    // Agent calls cad_route; controller creates the run internally.
    const controller = (await import("../src/core/controller.ts"));
    const piTools: any = { tools: new Map(), activeTools: [], events: { emit() {} } };
    // Reuse the real core tool definitions by loading runtime with a richer mock.
    const corePi = {
      ...pi,
      tools: new Map(),
      registerTool(tool: any) { corePi.tools.set(tool.name, tool); },
    };
    const core = (await import("../src/core/runtime.ts")).default;
    core(corePi);
    const routeTool = corePi.tools.get("cad_route");
    await routeTool.execute("r1", { workflow: "quick", reason: "test" }, undefined, undefined, ctx);
    const state = await store.load();
    assert.equal(state?.phase, "requirements");
    assert.ok(state?.runId);
    assert.equal(await store.currentRunId(), state.runId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/cad-abort clears only the run and leaves project head untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-abort-"));
  const pi = mockPi();
  try {
    const runtime = (await import("../src/core/runtime.ts")).default;
    runtime(pi);
    const ctx = { cwd, hasUI: true, ui: { notify() {} } } as any;
    const store = new CadProjectStore(cwd);
    const run = await store.createRun();
    const state = createIntakeState({ runId: run.runId, projectId: store.projectId });
    state.workflow = "greenfield";
    state.phase = "concept";
    await run.save(state);
    await store.updateHead({ artifactPath: "build/head.step", artifactHash: "head-hash" });

    await pi.commands.get("cad-abort").handler("", ctx);
    assert.equal(await store.currentRunId(), null);
    const project = await store.loadProject();
    assert.equal(project?.head.artifactPath, "build/head.step");
    const aborted = await run.load();
    assert.equal(aborted?.status, "aborted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
