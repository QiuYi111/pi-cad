import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { createIntakeState } from "../src/core/state-machine.ts";
import { managedSimulationRunner } from "../src/modules/simulate-v2/runtime.ts";
import { CadProjectStore } from "../src/shared/store.ts";

function fakePi() {
  const pi: any = {
    tools: new Map<string, any>(),
    commands: new Map<string, any>(),
    handlers: new Map<string, Function[]>(),
    activeTools: [] as string[],
    registerTool(tool: any) { pi.tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { pi.commands.set(name, command); },
    on(event: string, handler: Function) {
      const handlers = pi.handlers.get(event) ?? [];
      handlers.push(handler);
      pi.handlers.set(event, handlers);
    },
    setActiveTools(tools: string[]) { pi.activeTools = [...tools]; },
    getActiveTools() { return [...pi.activeTools]; },
    getAllTools() { return [...pi.tools.keys()].map((name) => ({ name })); },
    appendEntry() {},
    sendUserMessage() {},
    events: { emit() {}, on() {} },
  };
  return pi;
}

test("before_agent_start is read-only and never migrates or qualifies runtimes", async () => {
  const originalMigrate = CadProjectStore.prototype.migrate;
  const originalResolve = managedSimulationRunner.resolveRuntime;
  let migrationCalls = 0;
  let qualificationCalls = 0;
  CadProjectStore.prototype.migrate = async function () {
    migrationCalls += 1;
    return false;
  };
  managedSimulationRunner.resolveRuntime = async function () {
    qualificationCalls += 1;
    throw new Error("qualification must not run on the prompt path");
  };

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-fast-path-"));
  try {
    const pi = fakePi();
    const core = (await import("../src/extensions/core/index.ts")).default;
    core(pi);
    const beforeAgentStart = pi.handlers.get("before_agent_start")![0];

    await beforeAgentStart({ systemPrompt: "base" }, { cwd });
    assert.equal(existsSync(join(cwd, ".pi-cad")), false, "idle prompt projection must not create project storage");

    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "fast-run" });
    const state = {
      ...createIntakeState({ runId: "fast-run", projectId: store.projectId }),
      route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" } as const,
      phase: "review" as const,
    };
    await store.save(state);
    const statePath = join(cwd, ".pi-cad", "runs", "fast-run", "state.json");
    const before = readFileSync(statePath);

    await beforeAgentStart({ systemPrompt: "base" }, { cwd });
    const durations: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      await beforeAgentStart({ systemPrompt: "base" }, { cwd });
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1]!;

    assert.equal(migrationCalls, 0);
    assert.equal(qualificationCalls, 0);
    assert.deepEqual(readFileSync(statePath), before, "prompt projection must not mutate canonical state");
    assert.ok(p95Ms < 250, `warm prompt projection p95 was ${p95Ms.toFixed(1)}ms`);
  } finally {
    CadProjectStore.prototype.migrate = originalMigrate;
    managedSimulationRunner.resolveRuntime = originalResolve;
    rmSync(cwd, { recursive: true, force: true });
  }
});
