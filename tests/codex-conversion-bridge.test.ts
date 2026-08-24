import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CODE_MODE_PREFLIGHT_AVAILABLE,
  CODE_MODE_PREFLIGHT_PROTOCOL,
  CODE_MODE_PROVIDER_AVAILABLE,
  CODE_MODE_PROVIDER_PROTOCOL,
  registerPiCadNestedToolBridge,
} from "../src/integrations/codex-conversion.ts";
import cadProbeExtension from "../src/extensions/probe/index.ts";

test("conversion bridge projects active Pi-CAD tools and registers v7 preflight", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-code-mode-bridge-"));
  const previousKernel = process.env.PI_CAD_KERNEL;
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let preflight: any;
  let provider: any;
  const events: any = {
    on(name: string, handler: (value: unknown) => void) {
      const group = listeners.get(name) ?? new Set();
      group.add(handler); listeners.set(name, group);
      return () => group.delete(handler);
    },
    emit(name: string, value: unknown) { for (const handler of listeners.get(name) ?? []) handler(value); },
  };
  const tools: any[] = [];
  const shutdown: Array<() => void> = [];
  const pi: any = {
    events,
    registerTool(tool: unknown) { tools.push(tool); },
    getAllTools: () => tools.map(({ execute: _execute, ...tool }) => tool),
    getActiveTools: () => ["cad_recall_observation", "goal_complete"],
    on(name: string, handler: () => void) { if (name === "session_shutdown") shutdown.push(handler); },
  };
  const probePi: any = { ...pi, events, registerTool(tool: unknown) { tools.push(tool); } };
  const broker = {
    protocol: CODE_MODE_PREFLIGHT_PROTOCOL,
    isActive: () => true,
    register(value: unknown) { preflight = value; return () => { preflight = undefined; }; },
  };
  const providerBroker = {
    protocol: CODE_MODE_PROVIDER_PROTOCOL,
    isActive: () => true,
    register(value: unknown) { provider = value; return () => { provider = undefined; }; },
  };
  try {
    process.env.PI_CAD_KERNEL = "v7";
    cadProbeExtension(probePi);
    const bridge = registerPiCadNestedToolBridge(pi);
    events.emit(CODE_MODE_PREFLIGHT_AVAILABLE, broker);
    events.emit(CODE_MODE_PROVIDER_AVAILABLE, providerBroker);
    assert.equal(bridge.available, true);
    const nested = provider.getTools() as any[];
    const recall = nested.find((tool: any) => tool.name === "cad_recall_observation");
    assert.ok(recall, "provider publishes the stable action universe for multi-phase Code Mode loops");
    assert.match(recall.usage, /await tools\.cad_recall_observation\(\{/);
    assert.match(await recall.invoke({}, { toolCallId: "nested-1", extensionContext: { cwd } }, new AbortController().signal), /no active Pi-CAD workflow/);
    const denied = await preflight({ toolName: "cad_probe", input: {}, cwd });
    assert.equal(denied.block, true);
    assert.match(denied.reason, /no active run/);
    shutdown[0]!();
    assert.equal(bridge.available, false);
  } finally {
    if (previousKernel === undefined) delete process.env.PI_CAD_KERNEL;
    else process.env.PI_CAD_KERNEL = previousKernel;
    await rm(cwd, { recursive: true, force: true });
  }
});
