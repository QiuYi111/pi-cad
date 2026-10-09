import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { contextRebuildReasonV7, maybeRebuildContextV7 } from "../src/core/context-memory.ts";

test("v7 context rebuild uses the exited phase declaration and still honors the global threshold", () => {
  const phases = {
    parts: { rebuildContextOnExit: true },
    assembly: {},
  };
  assert.equal(contextRebuildReasonV7({ phase: "assembly", phaseHistory: ["parts", "assembly"] }, phases, { percent: 12, tokens: 1200 }), "phase_exit");
  assert.equal(contextRebuildReasonV7({ phase: "assembly", phaseHistory: ["assembly"] }, phases, { percent: 60, tokens: 6000 }), "threshold");
  assert.equal(contextRebuildReasonV7({ phase: "assembly", phaseHistory: ["assembly"] }, phases, { percent: 12, tokens: 1200 }), null);
});

test("v7 phase-exit rebuild calls compact once", () => {
  let compactCalls = 0;
  const ctx = {
    cwd: "/tmp/pi-cad-v7-phase-exit-test",
    getContextUsage: () => ({ percent: 12, tokens: 1200, contextWindow: 10000 }),
    compact: () => { compactCalls += 1; },
  } as unknown as ExtensionContext;
  const loaded = {
    state: { runId: "v7-trigger", phase: "assembly", phaseHistory: ["parts", "assembly"], status: "active" },
    workflow: { phases: { parts: { rebuildContextOnExit: true }, assembly: {} } },
  } as unknown as Parameters<typeof maybeRebuildContextV7>[1];
  const pi = {} as ExtensionAPI;
  assert.equal(maybeRebuildContextV7(pi, loaded, ctx), true);
  assert.equal(maybeRebuildContextV7(pi, loaded, ctx), false);
  assert.equal(compactCalls, 1);
});
