import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProjectStateStore } from "../src/shared/store.ts";
import { applyCadToolOverlay, PI_CAD_OWNED_TOOLS, toolsForPhase } from "../src/core/policies.ts";
import { CAPABILITY_TOOLS, CONTROL_TOOLS, type CadRequirements, type CadRunState } from "../src/shared/protocol.ts";
import { commitRequirements, createIntakeState, route as routeQuick, transition as transitionQuick } from "../src/core/state-machine.ts";

/**
 * Host double that behaves like the real Pi ExtensionAPI for tool
 * management: setActiveTools REPLACES the global set and getActiveTools
 * reads it back — including tools owned by other plugins (Goal, Ralph, ...).
 */
function hostPi(options: { registered?: string[]; initialActive?: string[] } = {}) {
  const registered = options.registered ?? [...CONTROL_TOOLS, ...CAPABILITY_TOOLS];
  const pi: any = {
    registered,
    activeTools: [...(options.initialActive ?? registered)],
    getAllTools() {
      return pi.registered.map((name: string) => ({ name }));
    },
    getActiveTools() {
      return [...pi.activeTools];
    },
    setActiveTools(names: string[]) {
      pi.activeTools = [...names];
    },
  };
  return pi;
}

const quickRoute = {
  objective: "design",
  lineage: "greenfield",
  structure: "part",
  maturity: "prototype",
} as const;

const EXTERNAL_TOOLS = ["goal_complete", "goal_blocked", "goal_wait", "some_other_plugin_tool"];

const record: CadRequirements = {
  goal: "test",
  deliverables: ["STEP"],
  must: [],
  preferences: [],
  assumptions: [],
  openUnknowns: [],
};

function quickRunState(phase: CadRunState["phase"], runId: string): CadRunState {
  const routed = routeQuick(null, quickRoute, "test");
  assert.ok(routed.ok);
  const built = commitRequirements(routed.state, record);
  assert.ok(built.ok);
  return { ...built.state, phase, runId };
}

test("plugin composition: external tools survive every Pi-CAD phase transition", async () => {
  // Session where Goal and another plugin are installed and active.
  const pi = hostPi({ initialActive: [...CONTROL_TOOLS, ...CAPABILITY_TOOLS, ...EXTERNAL_TOOLS] });

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-overlay-"));
  try {
    const store = new ProjectStateStore(cwd);
    await store.createRun({ runId: "overlay-run" });

    // Walk requirements -> build -> review -> ready; persist applies the
    // overlay at every step.
    let state = quickRunState("requirements", "overlay-run");
    for (const phase of ["requirements", "build", "review", "ready"] as const) {
      state = { ...state, phase };
      applyCadToolOverlay(pi, state);

      // 1. External plugin tools are untouched at every phase.
      for (const name of EXTERNAL_TOOLS) {
        assert.ok(
          pi.activeTools.includes(name),
          `${name} must stay active in phase ${phase}`,
        );
      }

      // 2. Pi-CAD's own tools follow the phase policy exactly.
      const allowed = new Set(toolsForPhase(phase));
      for (const name of PI_CAD_OWNED_TOOLS) {
        const inPolicy = allowed.has(name);
        assert.equal(
          pi.activeTools.includes(name),
          inPolicy,
          `${name} visibility in phase ${phase} must match the phase policy`,
        );
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plugin composition: Pi-CAD never activates an external tool the user disabled", () => {
  // goal_complete deliberately disabled; an unrelated plugin tool not even
  // in the registered set must also not be conjured up by name.
  const pi = hostPi({
    initialActive: [...CONTROL_TOOLS, "goal_complete", "goal_wait"],
  });
  // Simulate: user turned goal_complete off before the CAD run started.
  pi.activeTools = pi.activeTools.filter((name: string) => name !== "goal_complete");

  applyCadToolOverlay(pi, quickRunState("build", "r1"));

  assert.ok(!pi.activeTools.includes("goal_complete"), "disabled external tool must stay disabled");
  assert.ok(pi.activeTools.includes("goal_wait"), "still-active external tool must survive");
});

test("plugin composition: idle/done/aborted restores only the intake overlay", () => {
  const pi = hostPi({ initialActive: [...CONTROL_TOOLS, ...CAPABILITY_TOOLS, ...EXTERNAL_TOOLS] });

  // Active run leaves build-phase cad tools on.
  applyCadToolOverlay(pi, quickRunState("build", "r1"));
  assert.ok(pi.activeTools.includes("cad_commit_candidate"));

  // Run finishes: only cad_route among cad tools; externals untouched.
  applyCadToolOverlay(pi, { ...quickRunState("build", "r1"), status: "done" });
  for (const name of PI_CAD_OWNED_TOOLS) {
    assert.equal(
      pi.activeTools.includes(name),
      name === "cad_route",
      `after finish, ${name} must be active only if it is cad_route`,
    );
  }
  for (const name of EXTERNAL_TOOLS) {
    assert.ok(pi.activeTools.includes(name), `${name} must survive run completion`);
  }

  // Null state (project idle, fresh session) behaves the same.
  applyCadToolOverlay(pi, null);
  const cadActive = pi.activeTools.filter((name: string) => PI_CAD_OWNED_TOOLS.has(name));
  assert.deepEqual(cadActive, ["cad_route"]);
});

test("plugin composition: re-activating a phase-disallowed cad tool is still blocked by tool_call", async () => {
  const pi = {
    handlers: new Map<string, Function[]>(),
    on(event: string, handler: Function) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    activeTools: [] as string[],
    setActiveTools() {},
    getActiveTools(): string[] {
      return [...pi.activeTools];
    },
    getAllTools() {
      return [];
    },
    appendEntry() {},
    sendUserMessage() {},
    events: { emit() {}, on() {} },
    registerTool() {},
    registerCommand() {},
  };
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi as any);
  const toolCall = pi.handlers.get("tool_call")![0] as Function;

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-overlay-guard-"));
  try {
    const store = new ProjectStateStore(cwd);
    await store.createRun({ runId: "guard-run" });
    // requirements phase: cad_optimize is not in the phase policy.
    const state = quickRunState("requirements", "guard-run");
    await store.save(state);

    // Someone force-reactivates cad_optimize in the global set anyway.
    pi.activeTools = ["cad_optimize", "read", ...EXTERNAL_TOOLS];

    const blocked = (await toolCall(
      { toolName: "cad_optimize", input: {} },
      { cwd },
    )) as { block?: boolean; reason?: string };
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /not available in phase requirements/);

    // Allowed-phase tools keep flowing through the guard.
    const allowed = (await toolCall(
      { toolName: "cad_commit_requirements", input: {} },
      { cwd },
    )) as { block?: boolean };
    assert.notEqual(allowed?.block, true);

    // External tools are never phase-gated by Pi-CAD.
    const external = (await toolCall(
      { toolName: "goal_complete", input: {} },
      { cwd },
    )) as { block?: boolean };
    assert.notEqual(external?.block, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plugin composition: intake state routes via cad_route overlay on fresh sessions", () => {
  const pi = hostPi({ initialActive: [...EXTERNAL_TOOLS] });
  applyCadToolOverlay(pi, createIntakeState({ runId: "fresh" }));
  const cadActive = pi.activeTools.filter((name: string) => PI_CAD_OWNED_TOOLS.has(name));
  assert.deepEqual(cadActive, ["cad_route"]);
  for (const name of EXTERNAL_TOOLS) {
    assert.ok(pi.activeTools.includes(name));
  }
});
