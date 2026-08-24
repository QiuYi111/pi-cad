import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalBuiltinWorkflows } from "../src/domains/mechanical/workflows.ts";
import core from "../src/extensions/core/index.ts";
import { selectKernelEngine } from "../src/harness/engine-router.ts";
import { cadStart } from "../src/harness/kernel.ts";

test("engine router defaults new work to v7 and never lets fallback orphan an active v7 run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-engine-router-"));
  const previous = process.env.PI_CAD_KERNEL;
  try {
    delete process.env.PI_CAD_KERNEL;
    core({ registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; }, appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} } } as any);
    assert.equal(await selectKernelEngine(cwd), "v7");
    assert.equal(await selectKernelEngine(cwd, "v6"), "v6");
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "router test" });
    assert.equal(await selectKernelEngine(cwd, "v6"), "v7");
    await assert.rejects(selectKernelEngine(cwd, "bad"), /must be v6 or v7/);
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_KERNEL;
    else process.env.PI_CAD_KERNEL = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
