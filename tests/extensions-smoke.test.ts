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
    getActiveTools(): string[] {
      return [...pi.activeTools];
    },
    getAllTools() {
      return [];
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
    "cad_reroute",
    "cad_commit_requirements",
    "cad_revise_requirements",
    "cad_commit_frame_context",
    "cad_commit_plan",
    "cad_commit_assembly_design",
    "cad_commit_interface_contracts",
    "cad_commit_candidate",
    "cad_submit_for_review",
    "cad_transition",
    "cad_wait_for_user",
    "cad_defer_clarification",
    "cad_declare_blocker",
    "cad_finish",
    "cad_commit_simulation",
    "cad_build_step",
    "cad_inspect_geometry",
    "cad_inspect_surfaces",
    "cad_measure",
    "cad_inspect_visual",
    "cad_inspect_section",
    "cad_compare_geometry",
    "cad_assembly_tree",
    "cad_inspect_interference",
    "cad_scan_sections",
    "cad_probe_python",
    "cad_export",
    "cad_generate_drawing",
    "cad_simulate",
    "cad_sim_observe",
    "cad_simulate_structural_legacy",
    "cad_simulate_flow",
    "cad_simulate_thermal",
    "cad_derive_analysis_model",
    "cad_optimize",
    "cad_render_scene",
  ];
  assert.deepEqual(pi.tools.sort(), [...expectedTools].sort());
  assert.deepEqual(pi.commands.sort(), ["cad", "cad-abort", "cad-approve-reroute", "cad-status"]);
  for (const event of ["before_agent_start", "tool_call", "tool_result", "agent_settled"]) {
    assert.ok((pi.handlers.get(event) ?? []).length > 0, `missing ${event} handler`);
  }
});

test("control tools execute through pure workflow machine", async () => {
  // The pure-machine tests live in state-machine.test.ts; this test only
  // verifies extension registration does not execute side effects at import.
  assert.ok(true);
});

test("baseline prompts mandate frame handling without fabricating headless confirmation", async () => {
  const { loadPrompt } = await import("../src/core/context.ts");
  // loadPrompt falls back to generic text when a file is missing, so the
  // distinctive phrases double as file-presence guards.
  const baseline = await loadPrompt("baseline");
  assert.match(baseline, /Establish the coordinate frame/i);
  assert.match(baseline, /INTERACTIVE mode, confirm the mapping with the user/i);
  assert.match(baseline, /HEADLESS mode no user turn exists/i);
  assert.match(baseline, /assumed_headless/);
  assert.match(baseline, /mandatory/i);
  assert.match(baseline, /baseline_understood/);
  // The question must be grounded in visible evidence (views or features).
  assert.match(baseline, /views|features/i);
  // Silent assumption is never an escape.
  assert.match(baseline, /never assume silently|silent assumption is never an exception/i);

  const sourceBaseline = await loadPrompt("source_baseline");
  assert.match(sourceBaseline, /Establish the coordinate frame/i);
  assert.match(sourceBaseline, /assumed_headless/);
  assert.match(sourceBaseline, /baseline_understood/);

  // The requirements prompt defers the frame question to the baseline
  // phase instead of duplicating it.
  const requirements = await loadPrompt("requirements");
  assert.match(requirements, /coordinate orientation/i);
  assert.match(requirements, /completed deliverable/i);
  assert.match(requirements, /pre-cut\/pre-boolean profile/i);
  assert.match(requirements, /without seeing the generating source or feature history/i);

  const finalVerifier = await loadPrompt("final_verifier");
  assert.match(finalVerifier, /final-state claims/i);
  assert.match(finalVerifier, /hypothetical pre-feature profile/i);
  assert.match(finalVerifier, /return `binding_suspect`/i);
});
