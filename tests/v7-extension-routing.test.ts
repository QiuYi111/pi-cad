import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import core from "../src/extensions/core/index.ts";
import drawing from "../src/extensions/drawing/index.ts";
import geometry from "../src/extensions/geometry/index.ts";
import presentation from "../src/extensions/presentation/index.ts";
import probe from "../src/extensions/probe/index.ts";
import simulation from "../src/extensions/simulation/index.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
    on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    setActiveTools(values: string[]) { pi.active = values; }, getActiveTools() { return pi.active ?? []; }, getAllTools() { return [...tools.values()]; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} }, tools, handlers,
  };
  return pi;
}

test("public cad_route and record tools dispatch new work to v7 without creating v6 state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-extension-"));
  const previous = process.env.PI_CAD_KERNEL;
  try {
    process.env.PI_CAD_KERNEL = "v7";
    const pi = fakePi();
    for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
    const context = { cwd, hasUI: false } as any;
    const routeResult = await pi.tools.get("cad_route").execute("call-1", { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype", reason: "new part" }, undefined, undefined, context);
    assert.match(routeResult.content[0].text, /v7/);
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      await handler({ toolName: "cad_route", details: routeResult.details }, context);
    }
    assert.ok(pi.active.includes("cad_commit_requirements"), "route result must expose requirements tools in the same agent loop");
    assert.ok(!pi.active.includes("cad_route"), "route result must remove the completed intake action");
    let loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(loaded?.state.phase, "requirements");
    const requirementsResult = await pi.tools.get("cad_commit_requirements").execute("call-2", {
      goal: "Make a bracket", deliverables: ["STEP"], must: ["fit"],
      assertions: [{ id: "A1", mustRef: "M1", statement: "The completed bracket fits", binding: { subject: "completed bracket", quantity: "fit" }, expectation: { kind: "boolean", expected: true } }],
      preferences: [], assumptions: [], openUnknowns: [],
    }, undefined, undefined, context);
    assert.match(requirementsResult.content[0].text, /v7/);
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      await handler({ toolName: "cad_commit_requirements", details: requirementsResult.details }, context);
    }
    assert.ok(pi.active.includes("cad_commit_plan"), "requirements result must expose planning tools in the same agent loop");
    assert.ok(!pi.active.includes("cad_commit_requirements"), "requirements action must leave the completed phase overlay");
    loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(loaded?.state.records["record:requirements"]);
    assert.notEqual(loaded?.state.phase, "requirements");
    await assert.rejects(import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, ".pi-cad", "project.json"))), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_KERNEL;
    else process.env.PI_CAD_KERNEL = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
