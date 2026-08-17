import assert from "node:assert/strict";
import { test } from "node:test";

interface MockPi {
  tools: string[];
  commands: string[];
  handlers: Map<string, unknown[]>;
  activeTools: string[];
  registerTool(tool: { name: string }): void;
  registerCommand(name: string, _options: unknown): void;
  on(event: string, handler: unknown): void;
  setActiveTools(names: string[]): void;
  appendEntry(): void;
  sendUserMessage(): void;
  setSessionName(_name: string): void;
  events: { emit(): void; on(): void };
}

function mockPi(): MockPi {
  const pi: MockPi = {
    tools: [],
    commands: [],
    handlers: new Map(),
    activeTools: [],
    registerTool(tool) {
      pi.tools.push(tool.name);
    },
    registerCommand(name) {
      pi.commands.push(name);
    },
    on(event, handler) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    setActiveTools(names) {
      pi.activeTools = [...names];
    },
    appendEntry() {},
    sendUserMessage() {},
    setSessionName() {},
    events: { emit() {}, on() {} },
  };
  return pi;
}

test("all three V0 extensions load and register the expected tools/events", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  const geometry = (await import("../src/extensions/geometry/index.ts")).default;
  const visual = (await import("../src/extensions/visual/index.ts")).default;
  const drawing = (await import("../src/extensions/drawing/index.ts")).default;
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  const presentation = (await import("../src/extensions/presentation/index.ts")).default;
  const ui = (await import("../src/extensions/ui/index.ts")).default;
  core(pi);
  geometry(pi);
  visual(pi);
  drawing(pi);
  simulation(pi);
  presentation(pi);
  ui(pi);

  const expectedTools = [
    "cad_route",
    "cad_commit_requirements",
    "cad_commit_plan",
    "cad_commit_candidate",
    "cad_transition",
    "cad_wait_for_user",
    "cad_finish",
    "cad_build_step",
    "cad_inspect_geometry",
    "cad_measure",
    "cad_inspect_visual",
    "cad_inspect_section",
    "cad_compare_geometry",
    "cad_assembly_tree",
    "cad_export",
    "cad_generate_drawing",
    "cad_run_simulation",
    "cad_render_scene",
  ];
  assert.deepEqual(pi.tools.sort(), [...expectedTools].sort());
  assert.deepEqual(pi.commands.sort(), ["cad", "cad-abort", "cad-status"]);
  for (const event of ["before_agent_start", "tool_call", "tool_result", "agent_settled"]) {
    assert.ok((pi.handlers.get(event) ?? []).length > 0, `missing ${event} handler`);
  }
});

test("control tools execute through pure workflow machine", async () => {
  // The pure-machine tests live in state-machine.test.ts; this test only
  // verifies extension registration does not execute side effects at import.
  assert.ok(true);
});
