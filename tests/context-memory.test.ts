import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CadProjectStore, CadRunStore } from "../src/shared/store.ts";
import { commitPlan, commitRequirements, route as routeQuick } from "../src/core/state-machine.ts";
import { maybeAutoContinue } from "../src/core/continuation.ts";
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
    preferences: ["Prefer printable orientations"],
    assumptions: ["30% volume fraction is a working assumption, not a user constraint"],
    openUnknowns: ["Load case magnitude for the mounting interface"],
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

const FILE_OPS = { readFiles: ["models/bracket.py"], modifiedFiles: ["models/bracket.py"] };

function compactionEvent(messages: unknown[]) {
  return {
    preparation: {
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 12345,
      previousSummary: undefined,
      fileOps: FILE_OPS,
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
      firstKeptEntryId: "entry-7",
    },
    branchEntries: [],
    reason: "threshold" as const,
    willRetry: false,
    signal: new AbortController().signal,
  };
}

/** Fake ExtensionContext whose modelRegistry.complete captures its options. */
function fakeCtx(
  cwd: string,
  completeImpl?: (
    options: Record<string, unknown>,
  ) => { content: Array<{ type: string; text: string }>; usage?: unknown; stopReason?: string },
) {
  const calls: Array<{ request: unknown; options: Record<string, unknown> }> = [];
  const ctx = {
    cwd,
    model: { id: "fake-luna" },
    modelRegistry: {
      complete: async (_model: unknown, request: unknown, options: Record<string, unknown>) => {
        calls.push({ request, options });
        const out = completeImpl
          ? completeImpl(options)
          : {
              content: [
                {
                  type: "text",
                  text: "## Current understanding\n\nOCC sewing failed; reason: non-manifold geometry; do not retry unchanged.",
                },
              ],
              usage: { inputTokens: 1234, outputTokens: 567 },
              stopReason: "stop",
            };
        return out;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

function compactHandler(handlers: Map<string, Array<() => Promise<unknown>>>) {
  return handlers.get("session_before_compact")![0] as (
    event: ReturnType<typeof compactionEvent>,
    ctx: ExtensionContext,
  ) => Promise<{
    compaction?: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      usage?: unknown;
      details?: unknown;
    };
  } | undefined>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The user prompt text of the captured fresh working-context call. */
function capturedPrompt(call: { request: unknown }): string {
  const request = call.request as { messages: Array<{ content: Array<{ text?: string }> }> };
  return request.messages[0]!.content.map((block) => block.text ?? "").join("\n");
}

test("maybeRebuildContext: threshold gating, pending guard, and forced continuation after a consumed nudge key", async () => {
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

    // P0 regression: the rebuild fires on the SECOND+ autonomous
    // continuation of the same phase+artifact version. Consume the nudge
    // key first, exactly like a real run would at 40%...
    percent = 40;
    await maybeAutoContinue(pi, store, state, ctx);
    assert.equal(sent.length, 1);
    await maybeAutoContinue(pi, store, state, ctx);
    assert.equal(sent.length, 1, "ordinary settles stay deduped per state version");

    // ...then cross the threshold and rebuild.
    percent = 60;
    assert.equal(maybeRebuildContext(pi, store, state, ctx), true);
    assert.equal(compactCalls, 1);

    // Pending guard: same run never compacts twice concurrently.
    assert.equal(maybeRebuildContext(pi, store, state, ctx), false);
    assert.equal(compactCalls, 1);

    // Fire-and-forget resume: onComplete reloads state and FORCES the
    // continuation past the already-consumed nudge key.
    lastOptions!.onComplete!();
    await sleep(25);
    assert.equal(sent.length, 2, "post-rebuild continuation must bypass nudgedVersions");
    assert.ok(sent[1]!.includes("BUILD"), `nudge should mention the phase: ${sent[1]}`);

    // Guard cleared after completion.
    assert.equal(maybeRebuildContext(pi, store, state, ctx), true);
    assert.equal(compactCalls, 2);

    // A failed compaction also clears the guard and still continues the run
    // (one forced nudge per rebuild outcome).
    lastOptions!.onError!(new Error("provider down"));
    await sleep(25);
    assert.equal(sent.length, 3);
    assert.equal(maybeRebuildContext(pi, store, state, ctx), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: archives trajectory + image assets, passes usage/fileOps, uses medium reasoning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-compact-"));
  try {
    await seedRun(cwd, "compact-run");
    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = compactHandler(handlers);

    const imageBytes = Buffer.alloc(4096, 7);
    const messages = [
      { role: "user", content: [{ type: "text", text: "Reconstruct the density field into CAD." }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Trying OCC sewing on the optimized shell." }], timestamp: 2 },
      {
        role: "user",
        content: [
          { type: "text", text: "OCC sewing failed because of non-manifold geometry." },
          { type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" },
        ],
        timestamp: 3,
      },
    ];

    const { ctx, calls } = fakeCtx(cwd);
    const result = await handler(compactionEvent(messages), ctx);
    assert.ok(result, "handler should return a custom compaction");
    const run = new CadRunStore(cwd, "compact-run");

    // Minimal summary: references the archive, does not inline the trajectory.
    assert.ok(result.compaction!.summary.includes("ctx-001"));
    assert.ok(result.compaction!.summary.length < 500, "summary must stay short");
    assert.equal(result.compaction!.firstKeptEntryId, "entry-7");
    assert.equal(result.compaction!.tokensBefore, 12345);

    // Usage accounting + Pi's cumulative file tracking preserved.
    assert.deepEqual(result.compaction!.usage, { inputTokens: 1234, outputTokens: 567 });
    assert.deepEqual(result.compaction!.details, FILE_OPS);

    // The fresh call reasoned explicitly (absent reasoningEffort maps to
    // off/none in Pi's OpenAI Responses adapter, not to a default level),
    // with an output budget that survives medium reasoning + the document
    // (max_output_tokens covers both on the Responses API).
    assert.equal(calls[0]!.options.reasoningEffort, "medium");
    assert.equal(calls[0]!.options.maxTokens, 8192);
    assert.equal(calls[0]!.options.cacheRetention, "none");

    // Persistence: working.md + refs.jsonl + archive/ctx-001.json.
    const working = readFileSync(join(run.runDir, "context", "working.md"), "utf-8");
    assert.ok(working.includes("non-manifold geometry"), "dead ends must survive the rebuild");
    const refs = readFileSync(join(run.runDir, "context", "refs.jsonl"), "utf-8").trim().split("\n");
    assert.equal(refs.length, 1);
    const ref = JSON.parse(refs[0]) as { id: string; path: string; summary: string };
    assert.equal(ref.id, "ctx-001");
    assert.ok(ref.path.includes("archive/ctx-001.json"));
    assert.ok(ref.summary.includes("non-manifold"), "index label comes from the real user message");

    // Archive keeps the message structure...
    const archived = JSON.parse(
      readFileSync(join(run.runDir, "context", "archive", "ctx-001.json"), "utf-8"),
    ) as {
      messageCount: number;
      assets: Array<{ path: string; sha256: string; bytes: number }>;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(archived.messageCount, 3);
    assert.equal(archived.messages[0].content[0].text, "Reconstruct the density field into CAD.");

    // ...with inline images extracted byte-exactly into archive assets.
    assert.equal(archived.assets.length, 1);
    const asset = archived.assets[0];
    assert.ok(asset.path.endsWith("assets/ctx-001-001.png"));
    assert.equal(asset.bytes, imageBytes.byteLength);
    assert.equal(asset.sha256, createHash("sha256").update(imageBytes).digest("hex"));
    const assetPath = join(run.runDir, "context", "archive", "assets", "ctx-001-001.png");
    assert.ok(existsSync(assetPath), "image asset file must exist");
    assert.deepEqual(readFileSync(assetPath), imageBytes, "asset bytes must round-trip exactly");
    const imageBlock = archived.messages[2].content[1] as { type: string; data: string };
    assert.equal(imageBlock.type, "image");
    assert.ok(imageBlock.data.includes("assets/ctx-001-001.png"), "placeholder points at the asset");
    // JSON stays small: the base64 payload lives in the asset file, not the JSON.
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
    const handler = compactHandler(handlers);

    const { ctx } = fakeCtx(cwd, () => {
      throw new Error("provider down");
    });

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

test("session_before_compact: archive id never regresses when refs.jsonl loses entries, and archive I/O fails open", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-ids-"));
  try {
    await seedRun(cwd, "ids-run");
    const run = new CadRunStore(cwd, "ids-run");
    const contextDir = join(run.runDir, "context");
    mkdirSync(join(contextDir, "archive"), { recursive: true });
    // Two checkpoints on disk but a torn/lost refs.jsonl: a length-based id
    // would allocate ctx-001 again and overwrite history.
    writeFileSync(join(contextDir, "archive", "ctx-001.json"), "PRESERVE-1");
    writeFileSync(join(contextDir, "archive", "ctx-002.json"), "PRESERVE-2");

    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = compactHandler(handlers);
    const { ctx } = fakeCtx(cwd);

    const result = await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Continue the density reconstruction." }], timestamp: 1 },
      ]),
      ctx,
    );
    assert.ok(result);
    assert.ok(result.compaction!.summary.includes("ctx-003"), "id continues after the on-disk maximum");
    assert.equal(readFileSync(join(contextDir, "archive", "ctx-001.json"), "utf-8"), "PRESERVE-1");
    assert.equal(readFileSync(join(contextDir, "archive", "ctx-002.json"), "utf-8"), "PRESERVE-2");
    const refLine = JSON.parse(readFileSync(join(contextDir, "refs.jsonl"), "utf-8").trim()) as { id: string };
    assert.equal(refLine.id, "ctx-003");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: reference index skips harness-injected nudges", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-summary-"));
  try {
    await seedRun(cwd, "summary-run");
    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = compactHandler(handlers);
    const { ctx } = fakeCtx(cwd);

    await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Sewing failed; switching to a shell-based reconstruction." }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Understood, rebuilding as a shelled solid." }], timestamp: 2 },
        {
          role: "user",
          content: [{ type: "text", text: "Pi-CAD workflow is still in BUILD (route=... phase=build). Continue with the next explicit cad_* action." }],
          timestamp: 3,
        },
      ]),
      ctx,
    );
    const run = new CadRunStore(cwd, "summary-run");
    const ref = JSON.parse(readFileSync(join(run.runDir, "context", "refs.jsonl"), "utf-8").trim()) as { summary: string };
    assert.ok(ref.summary.startsWith("Sewing failed"), `label must come from the human message: ${ref.summary}`);
    assert.ok(!ref.summary.includes("Pi-CAD workflow is still in"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: broken archive storage fails open — compaction still proceeds", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-failopen-"));
  try {
    await seedRun(cwd, "failopen-run");
    const run = new CadRunStore(cwd, "failopen-run");
    const contextDir = join(run.runDir, "context");
    mkdirSync(contextDir, { recursive: true });
    // A regular file where the archive directory should be: mkdir fails.
    writeFileSync(join(contextDir, "archive"), "not a directory");

    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = compactHandler(handlers);
    const { ctx } = fakeCtx(cwd);

    const result = await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Keep iterating on the rib layout." }], timestamp: 1 },
      ]),
      ctx,
    );
    assert.ok(result, "archive failure must not break compaction");
    assert.ok(result.compaction!.summary.includes("could not be written"), "summary warns about the missing archive");
    assert.ok(existsSync(join(contextDir, "working.md")), "working.md is still refreshed");
    assert.equal(existsSync(join(contextDir, "refs.jsonl")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: length-truncated refresh is rejected, working.md marked stale and not injected until recovery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-truncated-"));
  try {
    await seedRun(cwd, "truncated-run");
    const run = new CadRunStore(cwd, "truncated-run");
    const contextDir = join(run.runDir, "context");
    mkdirSync(contextDir, { recursive: true });
    const oldBrain = "## Current intent\n\nOLD-BRAIN: sew the optimized shell directly.\n";
    writeFileSync(join(contextDir, "working.md"), oldBrain);

    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = compactHandler(handlers);

    // Reasoning ate the output budget: the visible document is cut mid-way.
    const { ctx } = fakeCtx(cwd, () => ({
      content: [{ type: "text", text: "## Current understanding\n\nOCC sewing fail" }],
      usage: { inputTokens: 9000, outputTokens: 8192 },
      stopReason: "length",
    }));
    const result = await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Second reconstruction attempt on the density field." }], timestamp: 1 },
      ]),
      ctx,
    );
    assert.equal(result, undefined, "truncated refresh must fall back to default compaction");

    // The half-written document never became the brain...
    assert.equal(readFileSync(join(contextDir, "working.md"), "utf-8"), oldBrain);
    // ...the archive is still durable (written before the refresh)...
    assert.ok(existsSync(join(contextDir, "archive", "ctx-001.json")));
    // ...and the failure is observable for experiment telemetry.
    const meta = JSON.parse(readFileSync(join(contextDir, "working.meta.json"), "utf-8")) as { status: string; reason: string };
    assert.equal(meta.status, "stale");
    assert.ok(meta.reason.includes("length"));
    const events = readFileSync(run.eventsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { stopReason?: string } });
    const failure = events.find((event) => event.type === "ContextMemoryUpdateFailed");
    assert.ok(failure, "journal must record the failed refresh");
    assert.equal(failure.data?.stopReason, "length");

    // Stale brain is not injected while the default summary carries the run.
    const state = await new CadProjectStore(cwd).load();
    assert.ok(state);
    const staleRendered = await renderTaskContext(cwd, state);
    assert.ok(staleRendered.includes("## Mission"));
    assert.ok(!staleRendered.includes("## Working Context"), "stale working.md must not be injected");
    assert.ok(!staleRendered.includes("OLD-BRAIN"));

    // Recovery: the next successful rebuild reactivates injection — and its
    // compactor prompt must not have received the stale OLD-BRAIN either.
    const { ctx: goodCtx, calls: goodCalls } = fakeCtx(cwd, () => ({
      content: [{ type: "text", text: "## Current understanding\n\nShell reconstruction abandoned; rib layout confirmed.\n" }],
      usage: { inputTokens: 8000, outputTokens: 2000 },
      stopReason: "stop",
    }));
    const recovered = await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Third attempt." }], timestamp: 1 },
      ]),
      goodCtx,
    );
    assert.ok(recovered, "successful refresh returns the custom compaction");
    assert.ok(!capturedPrompt(goodCalls[0]!).includes("OLD-BRAIN"), "stale brain stays quarantined from the recovery call");
    const activeMeta = JSON.parse(readFileSync(join(contextDir, "working.meta.json"), "utf-8")) as { status: string };
    assert.equal(activeMeta.status, "active");
    const recoveredRendered = await renderTaskContext(cwd, state);
    assert.ok(recoveredRendered.includes("## Working Context"));
    assert.ok(recoveredRendered.includes("rib layout confirmed"));
    assert.ok(!recoveredRendered.includes("OLD-BRAIN"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_before_compact: stale working.md is quarantined from the compactor input too", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-ctxmem-quarantine-"));
  try {
    await seedRun(cwd, "quarantine-run");
    const run = new CadRunStore(cwd, "quarantine-run");
    const contextDir = join(run.runDir, "context");
    mkdirSync(contextDir, { recursive: true });
    // A brain left stale by a failed refresh must not leak into the next
    // compactor either — only the main agent was quarantined before.
    writeFileSync(join(contextDir, "working.md"), "## Current intent\n\nOLD-BRAIN: sew the shell directly with OCC.\n");
    writeFileSync(
      join(contextDir, "working.meta.json"),
      JSON.stringify({ status: "stale", updatedAt: "2025-01-01T00:00:00Z", reason: "refresh stopped: length" }),
    );

    const { pi, handlers } = fakePi();
    registerContextCompaction(pi);
    const handler = compactHandler(handlers);
    const { ctx, calls } = fakeCtx(cwd);

    const result = await handler(
      compactionEvent([
        { role: "user", content: [{ type: "text", text: "Retry reconstruction via rib layout." }], timestamp: 1 },
      ]),
      ctx,
    );
    assert.ok(result, "successful refresh returns the custom compaction");
    const prompt = capturedPrompt(calls[0]!);
    assert.ok(!prompt.includes("OLD-BRAIN"), "stale brain must not enter the compactor prompt");
    assert.ok(!prompt.includes("sew the shell directly"), "stale intent text must not leak");
    assert.ok(
      prompt.includes("quarantined as stale"),
      "the placeholder must say the previous context was quarantined, not that this is the first rebuild",
    );
    // Successful refresh clears the quarantine.
    const meta = JSON.parse(readFileSync(join(contextDir, "working.meta.json"), "utf-8")) as { status: string };
    assert.equal(meta.status, "active");
    const state = await new CadProjectStore(cwd).load();
    assert.ok(state);
    const rendered = await renderTaskContext(cwd, state);
    assert.ok(rendered.includes("## Working Context"), "recovered brain is injected again");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderTaskContext: full Mission (assumptions/openUnknowns labelled provisional) + Working Context + bounded index", async () => {
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

    // Mission: every committed section, with anti-drift labels.
    assert.ok(rendered.includes("## Mission"));
    assert.ok(rendered.includes("Topology-optimized bracket with 30% mass reduction"));
    assert.ok(rendered.includes("- Preserve mounting bolt pattern"));
    assert.ok(rendered.includes("Assumptions (provisional"));
    assert.ok(rendered.includes("30% volume fraction is a working assumption"));
    assert.ok(rendered.includes("Open Unknowns"));
    assert.ok(rendered.includes("Load case magnitude"));
    assert.ok(rendered.includes("do not silently promote an assumption into a constraint"));
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

    // Empty requirement sections are omitted entirely.
    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "minimal-run" });
    const minimal = { ...state, runId: "minimal-run" };
    await new CadRunStore(cwd, "minimal-run").writeRecord("requirements", {
      goal: "Minimal bracket",
      deliverables: ["STEP artifact"],
      must: [],
      preferences: [],
      assumptions: [],
      openUnknowns: [],
    } satisfies CadRequirements);
    const minimalRendered = await renderTaskContext(cwd, minimal);
    assert.ok(minimalRendered.includes("Goal: Minimal bracket"));
    assert.ok(minimalRendered.includes("Deliverables:"));
    for (const header of ["Must:", "Preferences (soft", "Assumptions (provisional", "Open Unknowns (unresolved"]) {
      assert.ok(!minimalRendered.includes(header), `empty section must be omitted: ${header}`);
    }

    // Fresh run without working.md/refs still renders the mission alone.
    const fresh = await seedRun(cwd, "fresh-run");
    const freshRendered = await renderTaskContext(cwd, fresh);
    assert.ok(freshRendered.includes("## Mission"));
    assert.ok(!freshRendered.includes("## Working Context"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
