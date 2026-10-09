import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerContextCompaction, renderV7WorkingContext } from "../src/core/context-memory.ts";
import { commitMechanicalRecordV7 } from "../src/domains/mechanical/control-actions-v7.ts";
import { cadRouteV7 } from "../src/domains/mechanical/actions-v7.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalBuiltinWorkflows } from "../src/domains/mechanical/workflows.ts";
import { cadStart } from "../src/harness/kernel.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import core from "../src/extensions/core/index.ts";
import drawing from "../src/extensions/drawing/index.ts";
import geometry from "../src/extensions/geometry/index.ts";
import presentation from "../src/extensions/presentation/index.ts";
import probe from "../src/extensions/probe/index.ts";
import simulation from "../src/extensions/simulation/index.ts";

const FILE_OPS = { readFiles: ["models/bracket.py"], modifiedFiles: ["models/bracket.py"] };

function compactionEvent(messages: unknown[]) {
  return {
    preparation: {
      messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12345,
      previousSummary: undefined, fileOps: FILE_OPS, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
      firstKeptEntryId: "entry-7",
    },
    branchEntries: [], reason: "threshold" as const, willRetry: false, signal: new AbortController().signal,
  };
}

/** Fake context: every working-context refresh is answered by `reply`, and each request is captured. */
function fakeCtx(cwd: string, reply: () => { text: string; stopReason: string }) {
  const requests: unknown[] = [];
  const ctx = {
    cwd,
    model: { id: "fake-model" },
    modelRegistry: {
      complete: async (_model: unknown, request: unknown) => {
        requests.push(request);
        const out = reply();
        return { content: [{ type: "text", text: out.text }], usage: { inputTokens: 100, outputTokens: 50 }, stopReason: out.stopReason };
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, requests };
}

function fakePi() {
  const handlers = new Map<string, Array<(...args: any[]) => Promise<unknown>>>();
  const pi = {
    on(event: string, handler: (...args: any[]) => Promise<unknown>) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    sendUserMessage() {},
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

// Rule 9: v7 context archive is durable per checkpoint, and a failed refresh quarantines the stale brain.
test("v7 rules: compaction archives every checkpoint and a failed refresh quarantines the stale working context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-rules-context-"));
  try {
    for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension({ registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; }, appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} } } as any);
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "context rules" });
    await cadRouteV7({ cwd, route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" }, reason: "context rules" });
    await commitMechanicalRecordV7({ cwd, type: "requirements", value: { goal: "Bracket", deliverables: ["STEP"], must: ["fit"], assertions: [], preferences: [], assumptions: [], openUnknowns: [] } });
    const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    const runId = loaded!.state.runId;
    const runStore = new HarnessRunStoreV7(cwd, runId);
    const contextDir = join(runStore.runDirectory, "context");
    mkdirSync(contextDir, { recursive: true });

    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = handlers.get("session_before_compact")![0]!;
    const messages = [{ role: "user", content: [{ type: "text", text: "Reconstruct the bracket." }], timestamp: 1 }];

    // 1. A good refresh archives the trajectory and becomes the injected working context.
    let reply = { text: "## Current understanding\n\nBRAIN-ONE: the plate needs four bolt holes.", stopReason: "stop" };
    const first = fakeCtx(cwd, () => reply);
    const ok = await handler(compactionEvent(messages), first.ctx);
    assert.equal(ok?.compaction?.details && (ok.compaction.details as any).checkpointId, "ctx-001");
    assert.ok(existsSync(join(contextDir, "archive", "ctx-001.json")), "trajectory archived under the v7 run");
    assert.match(await renderV7WorkingContext(cwd, runId), /BRAIN-ONE/);

    // 2. A truncated refresh still archives, but the half-written brain is marked stale and no longer injected.
    reply = { text: "## Current understanding\n\nBRAIN-TWO partial", stopReason: "length" };
    const truncated = await handler(compactionEvent(messages), fakeCtx(cwd, () => reply).ctx);
    assert.equal(truncated, undefined, "failed refresh falls back to Pi's default compaction");
    assert.ok(existsSync(join(contextDir, "archive", "ctx-002.json")), "archive is written before the refresh");
    const meta = JSON.parse(readFileSync(join(contextDir, "working.meta.json"), "utf-8")) as { status: string };
    assert.equal(meta.status, "stale");
    assert.equal(await renderV7WorkingContext(cwd, runId), "", "stale working context is not injected into the main agent");

    // 3. The next compactor must not resurrect the quarantined brain.
    reply = { text: "## Current understanding\n\nBRAIN-THREE: rib layout, retry with fillets.", stopReason: "stop" };
    const retry = fakeCtx(cwd, () => reply);
    const recovered = await handler(compactionEvent(messages), retry.ctx);
    assert.ok(recovered, "successful refresh returns the custom compaction");
    const prompt = JSON.stringify(retry.requests[0]);
    assert.ok(!prompt.includes("BRAIN-ONE"), "stale brain must not enter the compactor prompt");
    assert.ok(prompt.includes("quarantined as stale"), "the placeholder says the previous context was quarantined");
    assert.equal(JSON.parse(readFileSync(join(contextDir, "working.meta.json"), "utf-8")).status, "active");
    const rendered = await renderV7WorkingContext(cwd, runId);
    assert.match(rendered, /BRAIN-THREE/);
    assert.ok(existsSync(join(contextDir, "archive", "ctx-003.json")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
