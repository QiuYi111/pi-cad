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

test("/cad archives terminal tasks and starts a new parent-linked task", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-commands-"));
  const pi = mockPi();
  try {
    const runtime = (await import("../src/core/runtime.ts")).default;
    runtime(pi);
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify() {} },
    } as any;

    const store = new CadProjectStore(cwd);
    const first = await store.createTask();
    const done = createIntakeState({ taskId: first.taskId });
    done.workflow = "greenfield";
    done.phase = "done";
    done.status = "done";
    await first.save(done);

    await pi.commands.get("cad").handler("", ctx);
    const currentId = await store.currentTaskId();
    assert.ok(currentId);
    assert.notEqual(currentId, first.taskId);
    const currentState = await store.load();
    assert.equal(currentState?.phase, "intake");
    assert.equal(currentState?.parentTaskId, first.taskId);

    await pi.commands.get("cad").handler("new prompt", ctx);
    assert.deepEqual(pi.sent, ["new prompt"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/cad-new refuses an active task and /cad-reroute resets a safe phase", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-commands2-"));
  const pi = mockPi();
  try {
    const runtime = (await import("../src/core/runtime.ts")).default;
    runtime(pi);
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify() {} },
    } as any;

    const store = new CadProjectStore(cwd);
    const task = await store.createTask();
    const active = createIntakeState({ taskId: task.taskId });
    active.workflow = "greenfield";
    active.phase = "concept";
    await task.save(active);

    await pi.commands.get("cad-new").handler("x", ctx);
    assert.equal(await store.currentTaskId(), task.taskId);
    assert.equal(pi.sent.length, 0);

    await pi.commands.get("cad-reroute").handler("", ctx);
    const state = await store.load();
    assert.equal(state?.workflow, null);
    assert.equal(state?.phase, "intake");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
