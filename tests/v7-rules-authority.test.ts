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
import { approveMechanicalRerouteV7, cadRerouteV7, cadRouteV7 } from "../src/domains/mechanical/actions-v7.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalBuiltinWorkflows } from "../src/domains/mechanical/workflows.ts";
import { cadStart } from "../src/harness/kernel.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { routeKey, type Route } from "../src/shared/route.ts";

const ASSEMBLY: Route = { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "engineering" };
const PART: Route = { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" };
const PART_PROTOTYPE: Route = { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" };

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
    on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    setActiveTools(values: string[]) { pi.active = [...values]; }, getActiveTools() { return [...(pi.active ?? [])]; }, getAllTools() { return [...tools.values()]; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} }, tools, handlers,
  };
  return pi;
}

async function withV7<T>(body: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-rules-authority-"));
  try {
    for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(fakePi());
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "v7 rules test" });
    return await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// Rule 5: a downgrade needs a one-time token bound to the exact approved route.
test("v7 rules: reroute downgrade is authorized only by a single-use token for the exact approved route", async () => {
  await withV7(async (cwd) => {
    await cadRouteV7({ cwd, route: ASSEMBLY, reason: "assembly intent" });
    await assert.rejects(cadRerouteV7({ cwd, route: PART, reason: "drop assembly duties" }), /requires authority/);
    let run = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(run?.state.status, "waiting_user", "the pending downgrade pauses the run for the user");
    assert.equal((run?.state.domainMetadata?.pendingReroute as any)?.routeKey, routeKey(PART));

    await approveMechanicalRerouteV7(cwd);
    // The token names the part route; a different downgrade still needs its own approval.
    await assert.rejects(cadRerouteV7({ cwd, route: PART_PROTOTYPE, reason: "other downgrade" }), /requires authority/);
    run = await cadRerouteV7({ cwd, route: PART, reason: "user approved scope reduction" });
    assert.equal((run.state.domainMetadata as any).route.structure, "part");
    const consumed = run.state.authorities.filter((item) => item.kind === "mechanical.reroute.downgrade");
    assert.equal(consumed.length, 1);
    assert.ok(consumed[0]!.consumedAt, "the token is consumed by the reroute it authorized");
    assert.equal((consumed[0]!.scope as any).route, routeKey(PART));

    // Consumed authority cannot authorize a second downgrade: scope back up (autonomous), then down again.
    await cadRerouteV7({ cwd, route: ASSEMBLY, reason: "scope back up" });
    await assert.rejects(cadRerouteV7({ cwd, route: PART, reason: "second downgrade without approval" }), /requires authority/);
  });
});

// Rule 8: external (non Pi-CAD) tools survive every phase transition.
test("v7 rules: external plugin tools stay active across v7 phase transitions", async () => {
  const EXTERNAL = ["goal_complete", "goal_blocked", "goal_wait", "some_other_plugin_tool"];
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-rules-external-"));
  try {
    const pi = fakePi();
    for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
    pi.active = [...EXTERNAL];
    const context = { cwd, hasUI: false } as any;
    const beforeAgentStart = async () => {
      await pi.handlers.get("before_agent_start")![0]({ systemPrompt: "" }, context);
      for (const name of EXTERNAL) assert.ok(pi.active.includes(name), `${name} must stay active`);
      return new Set<string>(pi.active);
    };
    const tool = (name: string) => pi.tools.get(name);

    const intake = await beforeAgentStart();
    assert.ok(intake.has("cad_route"), "intake exposes cad_route");
    assert.ok(!intake.has("cad_commit_requirements"));

    await tool("cad_route").execute("c1", { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype", reason: "part" }, undefined, undefined, context);
    const requirements = await beforeAgentStart();
    assert.ok(requirements.has("cad_commit_requirements"));

    await tool("cad_commit_requirements").execute("c2", { goal: "Make a bracket", deliverables: ["STEP"], must: ["fit"], assertions: [], preferences: [], assumptions: [], openUnknowns: [] }, undefined, undefined, context);
    const partDesign = await beforeAgentStart();
    assert.ok(partDesign.has("cad_commit_plan"), "part_design owes the plan record");
    assert.ok(!partDesign.has("cad_commit_requirements"), "phase policy changed the Pi-CAD-owned set");

    await tool("cad_commit_plan").execute("c3", { summary: "one solid", protected: [], plannedChanges: ["build"], interfaces: [], datums: [], reviewPlan: ["visual", "geometry"] }, undefined, undefined, context);
    const build = await beforeAgentStart();
    assert.ok(build.has("cad_commit_candidate"), "build exposes candidate commit");
    assert.ok(!build.has("cad_commit_plan"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
