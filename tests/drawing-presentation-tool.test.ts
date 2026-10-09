import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";

import drawing from "../src/extensions/drawing/index.ts";
import presentation from "../src/extensions/presentation/index.ts";

interface MockPi {
  tools: Map<string, any>;
  registerTool(tool: { name: string }): void;
  registerCommand(): void;
  on(): void;
  setActiveTools(): void;
  appendEntry(): void;
  sendUserMessage(): void;
  setSessionName(): void;
  events: { emit(): void; on(): void };
}

function mockPi(): MockPi {
  const pi: MockPi = {
    tools: new Map(),
    registerTool(tool) {
      pi.tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
    setSessionName() {},
    events: { emit() {}, on() {} },
  };
  return pi;
}

// Drawing and presentation are Recipe-only in v7: the structured v6 argument
// forms (artifact/views/directions) are no longer part of the tool boundary.
test("cad_generate_drawing and cad_render_scene accept only Recipe arguments", () => {
  const pi = mockPi();
  drawing(pi as any);
  presentation(pi as any);

  const generate = pi.tools.get("cad_generate_drawing");
  assert.ok(generate, "cad_generate_drawing is registered");
  assert.equal(Check(generate.parameters, { recipe: "drawings/plate", stage: "generate" }), true);
  assert.equal(Check(generate.parameters, { stage: "generate", artifact: "plate.step", views: [{ name: "front" }] }), false);

  const render = pi.tools.get("cad_render_scene");
  assert.ok(render, "cad_render_scene is registered");
  assert.equal(Check(render.parameters, { recipe: "presentations/hero", stage: "preview" }), true);
  assert.equal(Check(render.parameters, { stage: "preview", artifact: "boxes.step", directions: [] }), false);
});

test("drawing and presentation Recipe calls fail closed without a v7 run", async () => {
  const pi = mockPi();
  drawing(pi as any);
  presentation(pi as any);
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-recipe-tools-"));
  try {
    const generated = await pi.tools.get("cad_generate_drawing").execute("d1", { recipe: "drawings/plate", stage: "generate" }, undefined, undefined, { cwd });
    assert.equal(generated.isError, true);
    assert.match(generated.content[0].text, /^cad_generate_drawing failed:/);

    const rendered = await pi.tools.get("cad_render_scene").execute("p1", { recipe: "presentations/hero", stage: "preview" }, undefined, undefined, { cwd });
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /^cad_render_scene failed:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
