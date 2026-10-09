import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVE_PUBLIC_TOOL_NAMES } from "../src/shared/public-tools.ts";

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

test("all configured extensions load and register the expected tools/events", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  const probe = (await import("../src/extensions/probe/index.ts")).default;
  const geometry = (await import("../src/extensions/geometry/index.ts")).default;
  const drawing = (await import("../src/extensions/drawing/index.ts")).default;
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  const presentation = (await import("../src/extensions/presentation/index.ts")).default;
  const ui = (await import("../src/extensions/ui/index.ts")).default;
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
