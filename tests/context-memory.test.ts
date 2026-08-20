import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CadProjectStore, CadRunStore } from "../src/shared/store.ts";
import { commitPlan, commitRequirements, route as routeQuick } from "../src/core/state-machine.ts";
import type { CadRequirements, CadRunState } from "../src/shared/protocol.ts";
import {
  maybeRebuildContext,
  registerContextCompaction,
  renderTaskContext,
} from "../src/core/context-memory.ts";

/** Build a realistic build-phase run (intake -> requirements -> plan -> build). */
async function seedRun(cwd: string, runId: string): Promise<CadRunState> {
  const store = new CadProjectStore(cwd);
  await store.createRun({ runId });
  const quickRoute = {
    objective: "design",
    lineage: "greenfield",
    structure: "part",
    maturity: "prototype",
  } as const;
  const routed = routeQuick(null, quickRoute, "test");
  assert.ok(routed.ok, "route failed");
  if (!routed.ok) throw new Error("route failed");
  const record: CadRequirements = {
    goal: "Topology-optimized bracket with 30% mass reduction",
    deliverables: ["STEP artifact"],
    must: ["Preserve mounting bolt pattern"],
    preferences: [],
    assumptions: [],
    openUnknowns: [],
  };
  const built = commitRequirements(routed.state, record);
  assert.ok(built.ok, "requirements failed");
  if (!built.ok) throw new Error("requirements failed");
  const planned = commitPlan(built.state, {
    summary: "plan",
    protected: [],
    plannedChanges: [],
    interfaces: [],
    datums: [],
    reviewPlan: [],
  });
  assert.ok(planned.ok, "plan failed");
  if (!planned.ok) throw new Error("plan failed");
  const state = { ...planned.state, runId };
  await store.save(state);
  const run = new CadRunStore(cwd, runId);
  await run.writeRecord("requirements", record);
  return state;
}

function fakePi() {
  const handlers = new Map<string, Array<() => Promise<unknown>>>();
  const sent: string[] = [];
  const pi = {
    on(event: string, handler: () => Promise<unknown>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(text: string) {
      sent.push(text);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, sent };
}

function compactionEvent(messages: unknown[]) {
  return {
    preparation: {
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 12345,
      previousSummary: undefined,
      fileOps: { readFiles: [], modifiedFiles: [] },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
      firstKeptEntryId: "entry-7",
    },
    branchEntries: [],
    reason: "threshold" as const,
    willRetry: false,
    signal: new AbortController().signal,
  };
}

test("maybeRebuildContext: below threshold / null percent no-op; at threshold compacts once and resumes from onComplete/onError", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-trigger-"));
  try {
    const state = await seedRun(cwd, "trigger-run");
    const store = new CadProjectStore(cwd);
    const { pi, sent } = fakePi();

    let percent: number | null = 40;
    let compactCalls = 0;
    let lastOptions: { onComplete?: () => void; onError?: (error: Error) => void } | undefined;
    const ctx = {
      getContextUsage: () => ({ tokens: percent === null ? null : 1000, contextWindow: 10000, percent }),
      compact: (options?: typeof lastOptions) => {
        compactCalls += 1;
        lastOptions = options;
      },
    } as unknown as ExtensionContext;

    // Below threshold: continue normally.
    assert.equal(maybeRebuildContext(pi, store, state, ctx), false);
    assert.equal(compactCalls, 0);

    // percent is null right after a compaction: must not re-trigger.
    percent = null;
    assert.equal(maybeRebuildContext(pi, store, state, ctx), false);
    assert.equal(compactCalls, 0);

    // At 60%: compact, and the caller skips its own auto-continue.
    percent = 60;
    assert.equal(maybeRebuildContext(pi, store, state, ctx), true);
    assert.equal(compactCalls, 1);

    // Pending guard: same run never compacts twice concurrently.
    assert.equal(maybeRebuildContext(pi, store, state, ctx), false);
    assert.equal(compactCalls, 1);

    // Fire-and-forget resume: onComplete reloads state and nudges exactly once.
    assert.equal(sent.length, 0);
    lastOptions!.onComplete!();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes("BUILD"), `nudge should mention the phase: ${sent[0]}`);

    // Guard cleared after completion.
    assert.equal(maybeRebuildContext(pi, store, state, ctx), true);
    assert.equal(compactCalls, 2);

    // A failed compaction must also clear the guard. The continuation nudge
    // itself is deduped per state version by maybeAutoContinue (one nudge per
    // runId:phase:hashes), so the count stays at 1 — the run still continues.
    lastOptions!.onError!(new Error("provider down"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 1);
    assert.equal(maybeRebuildContext(pi, store, state, ctx), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: archives full trajectory, refreshes working.md, returns a minimal summary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-compact-"));
  try {
    await seedRun(cwd, "compact-run");
    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = handlers.get("session_before_compact")![0] as (
      event: ReturnType<typeof compactionEvent>,
      ctx: ExtensionContext,
    ) => Promise<{ compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } } | undefined>;

    const messages = [
      { role: "user", content: [{ type: "text", text: "Reconstruct the density field into CAD." }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Trying OCC sewing on the optimized shell." }], timestamp: 2 },
      {
        role: "user",
        content: [
          { type: "text", text: "OCC sewing failed because of non-manifold geometry." },
          { type: "image", data: "A".repeat(50_000), mimeType: "image/png" },
        ],
        timestamp: 3,
      },
    ];

    const ctx = {
      cwd,
      model: { id: "fake-luna" },
      modelRegistry: {
        complete: async () => ({
          content: [
            {
              type: "text",
              text: "## Current understanding\n\nOCC sewing failed; reason: non-manifold geometry; do not retry unchanged.",
            },
          ],
        }),
      },
    } as unknown as ExtensionContext;

    const result = await handler(compactionEvent(messages), ctx);
    assert.ok(result, "handler should return a custom compaction");
    const run = new CadRunStore(cwd, "compact-run");

    // Minimal summary: references the archive, does not inline the trajectory.
    assert.ok(result.compaction!.summary.includes("ctx-001"));
    assert.ok(result.compaction!.summary.length < 500, "summary must stay short");
    assert.equal(result.compaction!.firstKeptEntryId, "entry-7");
    assert.equal(result.compaction!.tokensBefore, 12345);

    // Persistence: working.md + refs.jsonl + archive/ctx-001.json.
    const working = readFileSync(join(run.runDir, "context", "working.md"), "utf-8");
    assert.ok(working.includes("non-manifold geometry"), "dead ends must survive the rebuild");
    const refs = readFileSync(join(run.runDir, "context", "refs.jsonl"), "utf-8").trim().split("\n");
    assert.equal(refs.length, 1);
    const ref = JSON.parse(refs[0]) as { id: string; path: string; summary: string };
    assert.equal(ref.id, "ctx-001");
    assert.ok(ref.path.includes("archive/ctx-001.json"));
    assert.ok(ref.summary.includes("non-manifold"));

    // Archive keeps the RAW messages (not the serialized/truncated text)…
    const archived = JSON.parse(
      readFileSync(join(run.runDir, "context", "archive", "ctx-001.json"), "utf-8"),
    ) as {
      messageCount: number;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(archived.messageCount, 3);
    assert.equal(archived.messages[0].content[0].text, "Reconstruct the density field into CAD.");
    // …with inline images stripped to placeholders (visuals persist under evidence/).
    const imageBlock = archived.messages[2].content[1] as { type: string; data: string };
    assert.equal(imageBlock.type, "image");
    assert.ok(imageBlock.data.startsWith("[stripped by context-memory:"));
    assert.ok(statSync(join(run.runDir, "context", "archive", "ctx-001.json")).size < 20_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: LLM failure falls back to default compaction but the archive is still durable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-fallback-"));
  try {
    await seedRun(cwd, "fallback-run");
    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = handlers.get("session_before_compact")![0] as (
      event: ReturnType<typeof compactionEvent>,
      ctx: ExtensionContext,
    ) => Promise<unknown>;

    const ctx = {
      cwd,
      model: { id: "fake-luna" },
      modelRegistry: {
        complete: async () => {
          throw new Error("provider down");
        },
      },
    } as unknown as ExtensionContext;

    const result = await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Attempt rib reconstruction heuristically." }], timestamp: 1 },
      ]),
      ctx,
    );
    assert.equal(result, undefined, "fall back to Pi's default compaction summary");
    const run = new CadRunStore(cwd, "fallback-run");
    assert.ok(existsSync(join(run.runDir, "context", "archive", "ctx-001.json")));
    assert.ok(existsSync(join(run.runDir, "context", "refs.jsonl")));
    assert.equal(existsSync(join(run.runDir, "context", "working.md")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderTaskContext: Mission + Working Context + bounded reference index, never the archive body", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-render-"));
  try {
    const state = await seedRun(cwd, "render-run");
    const run = new CadRunStore(cwd, "render-run");
    const contextDir = join(run.runDir, "context");
    mkdirSync(join(contextDir, "archive"), { recursive: true });
    writeFileSync(join(contextDir, "working.md"), "## Current understanding\n\nDensity field reconstructed; confirmed.\n");
    for (let i = 1; i <= 7; i += 1) {
      const id = `ctx-${String(i).padStart(3, "0")}`;
      const ref = {
        id,
        path: `archive/${id}.json`,
        createdAt: "2025-01-01T00:00:00Z",
        summary: `checkpoint ${i}`,
      };
      appendFileSync(join(contextDir, "refs.jsonl"), JSON.stringify(ref) + "\n");
    }
    writeFileSync(
      join(contextDir, "archive", "ctx-001.json"),
      JSON.stringify({ messages: [{ text: "ARCHIVE_BODY_MARKER_DO_NOT_RENDER" }] }),
    );

    const rendered = await renderTaskContext(cwd, state);

    // Mission from records/requirements.json.
    assert.ok(rendered.includes("## Mission"));
    assert.ok(rendered.includes("Topology-optimized bracket with 30% mass reduction"));
    assert.ok(rendered.includes("- Preserve mounting bolt pattern"));
    // Working context.
    assert.ok(rendered.includes("## Working Context"));
    assert.ok(rendered.includes("Density field reconstructed"));
    // Reference index: newest first, capped at the last 5 checkpoints.
    assert.ok(rendered.includes("## Available References"));
    assert.ok(rendered.includes("- ctx-007"));
    assert.ok(rendered.includes("- ctx-003"));
    assert.ok(!rendered.includes("- ctx-001"), "index must be capped, not the whole history");
    assert.ok(rendered.includes("7 checkpoints"));
    // The archive body itself never enters the prompt.
    assert.ok(!rendered.includes("ARCHIVE_BODY_MARKER_DO_NOT_RENDER"));
    // Section order: mission before working context before references.
    assert.ok(rendered.indexOf("## Mission") < rendered.indexOf("## Working Context"));
    assert.ok(rendered.indexOf("## Working Context") < rendered.indexOf("## Available References"));

    // Fresh run without working.md/refs still renders the mission alone.
    const fresh = await seedRun(cwd, "fresh-run");
    const freshRendered = await renderTaskContext(cwd, fresh);
    assert.ok(freshRendered.includes("## Mission"));
    assert.ok(!freshRendered.includes("## Working Context"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
