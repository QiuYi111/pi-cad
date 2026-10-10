import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type ToolDef = {
  name: string;
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string; [key: string]: unknown },
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: any }>;
};

function mockPi() {
  const pi: any = {
    tools: new Map<string, ToolDef>(),
    activeTools: [] as string[],
    events: { emit() {}, on() {} },
    registerTool(tool: ToolDef) {
      pi.tools.set(tool.name, tool);
    },
    on() {},
    registerCommand() {},
    setActiveTools(names: string[]) {
      pi.activeTools = [...names];
    },
    getActiveTools: () => [...pi.activeTools],
    getAllTools: () => [] as unknown[],
    appendEntry() {},
    sendUserMessage() {},
  };
  return pi;
}

// Two overlapping boxes: the harness auto-observes interference facts at
// candidate commit, and integration review cannot accept without them.
function assert_almost_equal(actual: number, expected: number, tol: number) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ~${expected}, got ${actual}`,
  );
}

test("cad_probe sections_scan reports area/moment facts for a box", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-sections-"));
  try {
    writeFileSync(join(cwd, "box.step"), readFileSync(new URL("../../fixtures/section_box.step", import.meta.url)));
    const pi = mockPi();
    const probeExtension = (await import("../../../src/extensions/probe/index.ts")).default;
    probeExtension(pi as never);
    const tool = pi.tools.get("cad_probe");
    const bad = await tool.execute("s0", { preset: "sections_scan", args: { artifact: "box.step", axis: "z" } }, undefined, undefined, { cwd });
    assert.match(bad.content[0].text as string, /exactly one of count or step/);

    const result = await tool.execute(
      "s1",
      { preset: "sections_scan", args: { artifact: "box.step", axis: "z", count: 3 } },
      undefined,
      undefined,
      { cwd },
    );
    assert.match(result.content[0].text as string, /3 sections along Z/);
    assert.match(result.content[0].text as string, /critical section is your judgment/);
    const payload = result.details.envelope.payload as {
      sections: Array<{ totalArea: number; faces: Array<{ Iu: number; Iv: number }> }>;
    };
    assert_almost_equal(payload.sections[0].totalArea, 1200, 1e-6);
    assert_almost_equal(payload.sections[0].faces[0].Iu, 90000, 1e-6);
    assert_almost_equal(payload.sections[0].faces[0].Iv, 160000, 1e-6);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
