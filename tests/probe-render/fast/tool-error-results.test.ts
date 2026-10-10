/**
 * Failed tool calls must reach Prime as isError=true. Content text stays the
 * same; only the error flag is asserted here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cwd = mkdtempSync(join(tmpdir(), "pi-cad-tool-error-"));
try {
  const { default: probeExt } = await import("../../../src/extensions/probe/index.ts");
  const tools = new Map<string, any>();
  probeExt({
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: () => {},
  } as any);

  const probe = tools.get("cad_probe");
  if (!probe) throw new Error("probe tools not registered");

  await test("cad_probe without a target returns isError=true with the same failure text", async () => {
    const result = await probe.execute("e1", { preset: "geometry" }, undefined, undefined, { cwd });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^cad_probe failed: provide exactly one target/);
  });

  await test("cad_probe with conflicting targets returns isError=true", async () => {
    const result = await probe.execute(
      "e2",
      { preset: "geometry", subject: "current", args: { artifact: "build/part.step" } },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /mutually exclusive/);
  });

} finally {
  rmSync(cwd, { recursive: true, force: true });
}
