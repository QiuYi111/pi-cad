/**
 * Pi-CAD Context Memory (MVP).
 *
 * Long agent runs degrade: the model keeps acting locally but loses the
 * original engineering goal, the current analysis line, and the record of
 * failed approaches. This module controls the context lifecycle instead of
 * the conversation:
 *
 *   - Canonical state (route/phase/artifacts/evidence) stays in
 *     `state.json` and is re-projected by `composeSystemPrompt()` every turn.
 *   - Working context (the current "brain": understanding / intent /
 *     attempts / open questions) lives in `context/working.md` and is
 *     re-injected on every `before_agent_start`.
 *   - Reference archive keeps the FULL pre-compaction trajectory (raw
 *     messages) in `context/archive/ctx-NNN.json`, indexed by
 *     `context/refs.jsonl`. It never enters the model context on its own;
 *     only a short index of checkpoints is rendered.
 *
 * Rebuild flow: when context usage crosses the threshold after an agent
 * settles, trigger `ctx.compact()`. The `session_before_compact` handler
 * archives the raw trajectory, refreshes `working.md` with one fresh LLM
 * call over a budgeted copy, and returns a minimal compaction summary.
 * `onComplete`/`onError` then resume `maybeAutoContinue()` with reloaded
 * canonical state (`ctx.compact()` is fire-and-forget, so without this the
 * run would stall after a rebuild).
 *
 * The handler serves every compaction path (manual /compact, Pi's own
 * threshold trigger, overflow recovery), not just self-triggered ones.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CadRequirements, CadRunState } from "../shared/protocol.ts";
import { CadProjectStore, CadRunStore, nowIso } from "../shared/store.ts";
import { maybeAutoContinue } from "./continuation.ts";

/** Rebuild threshold in Pi's percent scale (0-100). Experimental initial value. */
const DEFAULT_THRESHOLD_PERCENT = 55;
/** Char budget for the trajectory copy handed to the fresh working-context LLM. */
const DEFAULT_SUMMARIZER_BUDGET_CHARS = 240_000;
/** Hard render cap for working.md inside the system prompt (~4k tokens). */
const WORKING_CONTEXT_MAX_CHARS = 16_000;
/** How many archived checkpoints to list in the system prompt index. */
const ARCHIVE_INDEX_LIMIT = 5;
/** maxTokens for the fresh working-context update call. */
const UPDATE_MAX_TOKENS = 4096;

/**
 * Accept both `55` and `0.55` spellings. Pi computes
 * `percent = (tokens / contextWindow) * 100`, so a bare 0.55 would fire at
 * 0.55% usage; normalizing guards that exact footgun.
 */
function thresholdPercent(): number {
  const raw = process.env.PI_CAD_CONTEXT_REBUILD_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD_PERCENT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_THRESHOLD_PERCENT;
  return value <= 1 ? value * 100 : value;
}

function summarizerBudgetChars(): number {
  const value = Number(process.env.PI_CAD_CONTEXT_MEMORY_BUDGET_CHARS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SUMMARIZER_BUDGET_CHARS;
}

export interface ContextRef {
  id: string;
  path: string;
  createdAt: string;
  summary: string;
}

function contextDirOf(run: CadRunStore): string {
  return join(run.runDir, "context");
}

function workingPath(run: CadRunStore): string {
  return join(contextDirOf(run), "working.md");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function readRefs(run: CadRunStore): Promise<ContextRef[]> {
  const raw = await readText(join(contextDirOf(run), "refs.jsonl"));
  const refs: ContextRef[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      refs.push(JSON.parse(trimmed) as ContextRef);
    } catch {
      // Tolerate a torn final line from an interrupted append.
    }
  }
  return refs;
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... working context clipped at ${maxChars} chars; full file at context/working.md ...]`;
}

/**
 * Budget a serialized trajectory for the summarizer: keep the head (early
 * goal statements — the anti-drift anchor) and favor the tail (most recent
 * attempts and blockers). The archive keeps the untruncated original.
 */
function budgetClip(text: string): string {
  const budget = summarizerBudgetChars();
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.25);
  const tail = budget - head;
  const omitted = text.length - budget;
  return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted for this update; full trajectory is in the archive ...]\n\n${text.slice(-tail)}`;
}

/**
 * Replace inline base64 images with placeholders. Pi-CAD persists visual
 * evidence under evidence/, so nothing is lost — but raw message JSON with
 * embedded renders would bloat every archive file by megabytes.
 */
function stripInlineImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInlineImages);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      return {
        ...record,
        data: `[stripped by context-memory: ${record.data.length} chars; visual evidence persists under .pi-cad/runs/<runId>/evidence/]`,
      };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = stripInlineImages(item);
    return out;
  }
  return value;
}

/** Deterministic one-line label for the reference index (no extra LLM call). */
function indexSummary(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }
  return `${messages.length} messages`;
}

interface ArchivedTrajectory {
  ref: ContextRef;
  absolutePath: string;
}

async function archiveTrajectory(
  run: CadRunStore,
  messages: unknown[],
  meta: { reason: string; tokensBefore: number; firstKeptEntryId: string },
): Promise<ArchivedTrajectory> {
  const archiveDir = join(contextDirOf(run), "archive");
  await mkdir(archiveDir, { recursive: true });
  const seq = (await readRefs(run)).length + 1;
  const id = `ctx-${String(seq).padStart(3, "0")}`;
  const absolutePath = join(archiveDir, `${id}.json`);
  const payload = {
    id,
    createdAt: nowIso(),
    reason: meta.reason,
    tokensBefore: meta.tokensBefore,
    firstKeptEntryId: meta.firstKeptEntryId,
    messageCount: messages.length,
    messages: messages.map(stripInlineImages),
  };
  // Plain write is fine: the archive is append-only per checkpoint id, and a
  // torn write only loses this checkpoint file, never canonical state.
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  const ref: ContextRef = {
    id,
    path: `.pi-cad/runs/${run.runId}/context/archive/${id}.json`,
    createdAt: nowIso(),
    summary: indexSummary(messages),
  };
  await appendFile(join(contextDirOf(run), "refs.jsonl"), `${JSON.stringify(ref)}\n`, "utf-8");
  return { ref, absolutePath };
}

const WORKING_CONTEXT_PROMPT = `You maintain Pi-CAD's working context for a long-running engineering task.

Do NOT summarize the whole conversation.

Do NOT repeat:
- mission / user requirements
- workflow phase
- artifact hashes
- canonical state already maintained by Pi-CAD

Update only what a fresh engineering agent needs to continue reasoning.

Separate confirmed facts from hypotheses.

Preserve failed approaches sufficiently so they are not blindly repeated.

Keep the whole output under ~3000 words.

Output ONLY:

## Current understanding

## Current intent

## Attempts / blockers / resolutions

## Open questions`;

function resolveUpdateModel(ctx: ExtensionContext): unknown | undefined {
  const spec = process.env.PI_CAD_CONTEXT_MEMORY_MODEL;
  if (spec) {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const registry = ctx.modelRegistry as unknown as {
        find?: (provider: string, modelId: string) => unknown | undefined;
      };
      const found = registry.find?.(spec.slice(0, slash), spec.slice(slash + 1));
      if (found) return found;
    }
  }
  return ctx.model;
}

/**
 * Refresh working.md with one fresh LLM call over a budgeted copy of the
 * trajectory. Returns false when no model is available or the call fails —
 * callers must then fall back to Pi's default compaction summary (the
 * archive is still written; only the custom summary is skipped).
 */
async function updateWorkingContext(
  ctx: ExtensionContext,
  run: CadRunStore,
  messages: unknown[],
  signal: AbortSignal,
): Promise<boolean> {
  const model = resolveUpdateModel(ctx);
  if (!model) return false;
  const registry = ctx.modelRegistry as unknown as {
    complete?: (
      model: unknown,
      request: { messages: Array<Record<string, unknown>> },
      options: Record<string, unknown>,
    ) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (!registry.complete) return false;

  try {
    const previous = await readText(workingPath(run));
    const conversation = budgetClip(serializeConversation(convertToLlm(messages as never)));
    const prompt = [
      WORKING_CONTEXT_PROMPT,
      "<previous working context>",
      previous.trim() || "(none yet — this is the first rebuild)",
      "</previous working context>",
      "<trajectory since previous checkpoint>",
      conversation,
      "</trajectory>",
    ].join("\n\n");

    const response = await registry.complete(
      model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      { maxTokens: UPDATE_MAX_TOKENS, signal, cacheRetention: "none" },
    );
    const text = (response.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n")
      .trim();
    if (!text) return false;
    await mkdir(contextDirOf(run), { recursive: true });
    await writeFile(workingPath(run), `${text}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function renderMission(requirements: CadRequirements): string {
  const lines = ["## Mission", "", `Goal: ${requirements.goal}`];
  if (requirements.must?.length) {
    lines.push("", "Must:", ...requirements.must.map((item) => `- ${item}`));
  }
  if (requirements.deliverables?.length) {
    lines.push("", "Deliverables:", ...requirements.deliverables.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

/**
 * Render the per-run task context appended to the system prompt:
 * Mission (from records/requirements.json) + Working Context (working.md) +
 * a short index of archived checkpoints. Canonical state is NOT summarized
 * here — `composeSystemPrompt()` already re-projects it every turn.
 * Returns "" when nothing exists yet (fresh run).
 */
export async function renderTaskContext(cwd: string, state: CadRunState): Promise<string> {
  const run = new CadRunStore(cwd, state.runId);
  const sections: string[] = [];

  const requirements = await readJson<CadRequirements>(join(run.recordsDir, "requirements.json"));
  if (requirements?.goal) sections.push(renderMission(requirements));

  const working = (await readText(workingPath(run))).trim();
  if (working) sections.push(`## Working Context\n\n${clip(working, WORKING_CONTEXT_MAX_CHARS)}`);

  const refs = await readRefs(run);
  if (refs.length) {
    const index = refs
      .slice(-ARCHIVE_INDEX_LIMIT)
      .reverse()
      .map((ref) => `- ${ref.id} — ${ref.summary}`);
    const archiveNote = refs.length > ARCHIVE_INDEX_LIMIT
      ? `.pi-cad/runs/${state.runId}/context/archive/ (${refs.length} checkpoints)`
      : `.pi-cad/runs/${state.runId}/context/archive/`;
    sections.push(
      [
        "## Available References",
        "",
        ...index,
        "",
        `Full records are archived under ${archiveNote}. Read them only when investigating past attempts.`,
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * Per-run compaction bookkeeping. Keyed by cwd:runId so two projects or
 * sessions sharing this process never block each other.
 */
const pendingCompactions = new Set<string>();

/**
 * Decide whether to rebuild context now. Pi's `ctx.compact()` is
 * fire-and-forget, so continuation is resumed from onComplete/onError with
 * freshly loaded canonical state. Returns true when a compaction was
 * requested (the caller must then skip its own auto-continue for this
 * settle). `percent`/`tokens` are null right after a compaction and before
 * the next LLM response — that reads as "do not trigger", which also
 * prevents rebuild loops.
 */
export function maybeRebuildContext(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  ctx: ExtensionContext,
): boolean {
  const usage = ctx.getContextUsage();
  if (!usage || usage.percent == null || usage.tokens == null) return false;
  if (usage.percent < thresholdPercent()) return false;
  const key = `${store.cwd}:${state.runId}`;
  if (pendingCompactions.has(key)) return false;
  pendingCompactions.add(key);

  const resume = () => {
    pendingCompactions.delete(key);
    void (async () => {
      // Reload: canonical state is authoritative, and compaction must never
      // resume from a stale pre-compaction snapshot.
      const latest = await store.load();
      if (!latest) return;
      await maybeAutoContinue(pi, store, latest, ctx);
    })();
  };
  ctx.compact({ onComplete: resume, onError: resume });
  return true;
}

/**
 * Register the context-memory compaction hook. Serves every compaction
 * path: manual /compact, Pi's threshold trigger, and overflow recovery
 * (where Pi retries the aborted turn itself — this handler only preserves
 * information; it never drives continuation).
 */
export function registerContextCompaction(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    if (event.signal.aborted) return undefined;
    const store = new CadProjectStore(ctx.cwd);
    const state = await store.load();
    if (!state || state.status === "done" || state.status === "aborted") return undefined;

    const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
    if (!messages.length) return undefined;
    const run = new CadRunStore(ctx.cwd, state.runId);

    // 1. Archive the full raw trajectory first: pure file I/O, independent
    //    of the LLM below, so a failed update never loses history.
    const { ref, absolutePath: _absolutePath } = await archiveTrajectory(run, messages, {
      reason: event.reason,
      tokensBefore: event.preparation.tokensBefore,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
    });

    // 2. Fresh LLM refresh of working.md over a budgeted copy.
    const updated = await updateWorkingContext(ctx, run, messages, event.signal);
    if (!updated) {
      // Fall back to Pi's default compaction summary; archive + refs above
      // are already durable.
      return undefined;
    }

    // 3. Minimal compaction entry: mission, canonical state, and working
    //    context are re-injected by before_agent_start on the next run.
    return {
      compaction: {
        summary: [
          `Pi-CAD context rebuild (${ref.id}).`,
          `Full trajectory archived at ${ref.path}; working context updated at context/working.md.`,
          "Mission, canonical state, and working context are re-injected in the system prompt — do not re-derive them from this history.",
        ].join(" "),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}
