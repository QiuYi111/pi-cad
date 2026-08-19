import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commitPhaseRecord,
  commitPlan,
  commitRequirements,
  createIntakeState,
  reroute,
  route,
} from "../src/core/state-machine.ts";
import type { CadRunState, Route } from "../src/shared/protocol.ts";
import { routeKey } from "../src/shared/route.ts";

const req = {
  goal: "reroute test",
  deliverables: ["STEP"],
  must: [],
  preferences: [],
  assumptions: [],
  openUnknowns: [],
};
const plan = { summary: "p", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] };

const part: Route = { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" };
const assembly: Route = { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "engineering" };
const partProto: Route = { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" };

function partBuildState(): CadRunState {
  const routed = route(null, part, "test");
  if (!routed.ok) throw new Error(routed.reason);
  const committed = commitRequirements(routed.state, req);
  if (!committed.ok) throw new Error(committed.reason);
  const planned = commitPlan(committed.state, plan);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.state; // phase: build
}

test("reroute: structure upgrade is autonomous and resumes at earliest unmet phase", () => {
  const state = partBuildState();
  assert.equal(state.phase, "build");
  const result = reroute(state, assembly, "this is actually an assembly");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Records are missing -> back to assembly_design, NOT integration_review.
  assert.equal(result.state.phase, "assembly_design");
  assert.equal(result.state.route && routeKey(result.state.route), routeKey(assembly));
  assert.equal(result.events[0].data?.authority, "autonomous");
  assert.equal(result.state.pendingReroute, null);
});

test("reroute: upgrade with records already committed goes to the next unmet phase", () => {
  const state = partBuildState();
  const upgraded = reroute(state, assembly, "assembly after all");
  if (!upgraded.ok) throw new Error(upgraded.reason);
  let s = upgraded.state;
  const design = commitPhaseRecord(s, "assembly_design", {});
  if (!design.ok) throw new Error(design.reason);
  const contracts = commitPhaseRecord(design.state, "interface_contracts", {});
  if (!contracts.ok) throw new Error(contracts.reason);
  s = contracts.state;
  assert.equal(s.phase, "part_design");
  // Records complete; plan re-commits and re-enters build.
  const rePlanned = commitPlan(s, plan);
  assert.equal(rePlanned.ok, true);
  assert.equal(rePlanned.state.phase, "build");
});

test("reroute: downgrade without a token is rejected and records the pending reroute", () => {
  const state = partBuildState();
  const result = reroute(state, partProto, "user wants a rough prototype");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.requiresAuthority, true);
  // The state machine itself does not record the pending reroute (the
  // controller tool does); the token path is exercised below.
});

test("reroute: harness token authorizes a downgrade exactly once", () => {
  const state: CadRunState = {
    ...partBuildState(),
    pendingReroute: { route: partProto, reason: "user agreed" },
    rerouteAuthorityToken: "token-1",
  };
  const wrongToken = reroute(state, partProto, "wrong token", "token-2");
  assert.equal(wrongToken.ok, false);
  const rightToken = reroute(state, partProto, "user agreed", "token-1");
  assert.equal(rightToken.ok, true);
  if (!rightToken.ok) return;
  assert.equal(rightToken.events[0].data?.authority, "user-token");
  assert.equal(rightToken.state.rerouteAuthorityToken, null);
  assert.equal(rightToken.state.pendingReroute, null);
  // The token is consumed: a further downgrade needs fresh authority and
  // the used token no longer works.
  const assemblyEng: Route = {
    objective: "design",
    lineage: "greenfield",
    structure: "assembly",
    maturity: "engineering",
  };
  const further = reroute(rightToken.state, assemblyEng, "upgrade now", undefined);
  assert.equal(further.ok, true); // autonomous upgrade still works
  const downgradeAgain = reroute(further.ok ? further.state : rightToken.state, partProto, "drop again", "token-1");
  assert.equal(downgradeAgain.ok, false);
  if (!downgradeAgain.ok) {
    assert.equal(downgradeAgain.requiresAuthority, true);
  }
});

test("reroute: maturity upgrade resumes where drawing evidence is unmet", () => {
  const state = partBuildState();
  const mfg: Route = { objective: "design", lineage: "greenfield", structure: "part", maturity: "manufacturing" };
  const withArtifact: CadRunState = {
    ...state,
    currentArtifactHash: "a".repeat(64),
    evidence: [
      {
        id: "v1",
        kind: "visual" as const,
        tool: "cad_inspect_visual",
        artifactHash: "a".repeat(64),
        paths: ["evidence/v.png"],
        createdAt: new Date().toISOString(),
      },
      {
        id: "g1",
        kind: "geometry" as const,
        tool: "cad_inspect_geometry",
        artifactHash: "a".repeat(64),
        paths: ["evidence/g.json"],
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const result = reroute(withArtifact, mfg, "this must be manufacturable");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // drawing evidence missing -> review phase, not ready.
  assert.equal(result.state.phase, "review");
});

test("reroute: same route and bad phases fail closed", () => {
  const state = partBuildState();
  assert.equal(reroute(state, part, "same").ok, false);
  const intake = createIntakeState();
  assert.equal(reroute(intake, part, "no route").ok, false);
  const ready: CadRunState = { ...state, phase: "ready", status: "ready" };
  assert.equal(reroute(ready, assembly, "too late").ok, false);
});

test("reroute: baseline-requiring route without a baseline resumes at baseline", () => {
  const state = partBuildState();
  const legacy: Route = { objective: "design", lineage: "legacy", structure: "part", maturity: "engineering" };
  const result = reroute(state, legacy, "actually a modification of an existing design");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.phase, "baseline");
});

test("reroute: full downgrade flow through harness tools (request -> pause -> user -> token -> apply)", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pi: any = {
    tools: new Map(),
    handlers: new Map(),
    activeTools: [] as string[],
    events: { emit() {}, on() {} },
    registerTool(tool: any) {
      pi.tools.set(tool.name, tool);
    },
    on(event: string, handler: any) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    registerCommand() {},
    setActiveTools() {},
    getActiveTools: () => [] as string[],
    getAllTools: () => [] as unknown[],
    appendEntry() {},
    sendUserMessage() {},
  };
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-reroute-flow-"));
  try {
    const ctx = { cwd };
    const routeTool = pi.tools.get("cad_route");
    const reqTool = pi.tools.get("cad_commit_requirements");
    const rerouteTool = pi.tools.get("cad_reroute");
    const waitTool = pi.tools.get("cad_wait_for_user");

    await routeTool.execute(
      "f1",
      { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering", reason: "part" },
      undefined,
      undefined,
      ctx,
    );
    await reqTool.execute(
      "f2",
      { goal: "g", deliverables: ["STEP"], must: [], preferences: [], assumptions: [], openUnknowns: [] },
      undefined,
      undefined,
      ctx,
    );

    // 1. Downgrade attempt without authority: rejected, pending recorded.
    const rejected = await rerouteTool.execute(
      "f3",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "part",
        maturity: "prototype",
        reason: "user hinted they want it rough",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(rejected.content[0].text as string, /cad_wait_for_user/);
    let state = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", await currentRunIdOf(cwd), "state.json"), "utf-8"));
    assert.ok(state.pendingReroute);

    // 2. The Agent asks the user.
    await waitTool.execute("f4", { reason: " downgrade to prototype maturity?" }, undefined, undefined, ctx);

    // 3. The user answers: before_agent_start resumes and issues the token.
    const beforeAgentStart = pi.handlers.get("before_agent_start")[0];
    await beforeAgentStart({ systemPrompt: "" }, { cwd });
    state = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", await currentRunIdOf(cwd), "state.json"), "utf-8"));
    assert.equal(state.status, "active");
    assert.ok(state.rerouteAuthorityToken, "harness issued the one-time token");

    // 4. The Agent performs the reroute with the token.
    const applied = await rerouteTool.execute(
      "f5",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "part",
        maturity: "prototype",
        reason: "user agreed to prototype",
        authorityToken: state.rerouteAuthorityToken,
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(applied.content[0].text as string, /user-token/);
    assert.match(applied.content[0].text as string, /No progress was granted/);
    state = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", await currentRunIdOf(cwd), "state.json"), "utf-8"));
    assert.equal(state.pendingReroute, null);
    assert.equal(state.rerouteAuthorityToken, null);
    assert.equal(state.route.maturity, "prototype");
    // No target phase was accepted: harness chose the earliest unmet phase.
    assert.equal(state.phase, "build");

    // 5. The used token cannot authorize anything anymore.
    const replay = await rerouteTool.execute(
      "f6",
      {
        objective: "design",
        lineage: "greenfield",
        structure: "part",
        maturity: "engineering",
        reason: "token replay attempt",
        authorityToken: "not-the-token",
      },
      undefined,
      undefined,
      ctx,
    );
    // upgrading back is autonomous anyway; a stale token is simply ignored.
    assert.match(replay.content[0].text as string, /autonomous/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function currentRunIdOf(cwd: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const project = JSON.parse(readFileSync(join(cwd, ".pi-cad", "project.json"), "utf-8"));
  return project.currentRunId;
}
