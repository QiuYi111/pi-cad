import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ACTIVE_PUBLIC_TOOL_NAMES } from "../../../src/shared/public-tools.ts";

interface MockPi {
  tools: string[];
  commands: string[];
  toolObjects: Map<string, any>;
  commandObjects: Map<string, (args: string, ctx: any) => Promise<void>>;
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
    toolObjects: new Map(),
    commandObjects: new Map(),
    handlers: new Map(),
    activeTools: [],
    registerTool(tool) {
      pi.tools.push(tool.name);
      pi.toolObjects.set(tool.name, tool);
    },
    registerCommand(name, options) {
      pi.commands.push(name);
      pi.commandObjects.set(name, (options as { handler: (args: string, ctx: any) => Promise<void> }).handler);
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

test("all configured extensions load and register the expected tools/events", async () => {
  const pi = mockPi();
  const core = (await import("../../../src/extensions/core/index.ts")).default;
  const probe = (await import("../../../src/extensions/probe/index.ts")).default;
  const geometry = (await import("../../../src/extensions/geometry/index.ts")).default;
  const drawing = (await import("../../../src/extensions/drawing/index.ts")).default;
  const simulation = (await import("../../../src/extensions/simulation/index.ts")).default;
  const presentation = (await import("../../../src/extensions/presentation/index.ts")).default;
  const ui = (await import("../../../src/extensions/ui/index.ts")).default;
  core(pi);
  probe(pi);
  geometry(pi);
  drawing(pi);
  simulation(pi);
  presentation(pi);
  ui(pi);

  assert.deepEqual(pi.tools.sort(), [...ACTIVE_PUBLIC_TOOL_NAMES].sort());
  assert.deepEqual(pi.commands.sort(), ["cad", "cad-abort", "cad-approve-reroute", "cad-status"]);
  for (const event of ["before_agent_start", "tool_call", "agent_settled"]) {
    assert.ok((pi.handlers.get(event) ?? []).length > 0, `missing ${event} handler`);
  }
});

test("cad-status shows the active v7 run phase and run id, and reports idle when no run exists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-status-"));
  try {
    const pi = mockPi();
    const core = (await import("../../../src/extensions/core/index.ts")).default;
    const probe = (await import("../../../src/extensions/probe/index.ts")).default;
    const geometry = (await import("../../../src/extensions/geometry/index.ts")).default;
    const drawing = (await import("../../../src/extensions/drawing/index.ts")).default;
    const simulation = (await import("../../../src/extensions/simulation/index.ts")).default;
    const presentation = (await import("../../../src/extensions/presentation/index.ts")).default;
    const ui = (await import("../../../src/extensions/ui/index.ts")).default;
    for (const extension of [core, probe, geometry, drawing, simulation, presentation, ui]) extension(pi as any);

    const notices: string[] = [];
    const widgets: string[][] = [];
    const statusContext = {
      cwd,
      hasUI: true,
      mode: "tui",
      ui: { notify(message: string) { notices.push(message); }, setWidget(_key: string, lines: string[]) { widgets.push(lines); } },
    };
    const status = pi.commandObjects.get("cad-status")!;
    await status("", statusContext);
    assert.deepEqual(notices, ["No Pi-CAD workflow is active"]);

    await pi.toolObjects.get("cad_route").execute("call-status", {
      objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype", reason: "status check",
    }, undefined, undefined, { cwd, hasUI: false });
    await status("", statusContext);
    const [lines] = widgets.slice(-1);
    assert.ok(lines, "cad-status renders a widget for an active run");
    assert.match(lines.join("\n"), /^Pi-CAD · workflow=\S+/m);
    assert.match(lines.join("\n"), /^run=v7-\S+/m);
    assert.match(lines.join("\n"), /^phase=\S+ status=\S+/m);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
