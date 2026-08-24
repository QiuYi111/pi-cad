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
 *     re-injected on every `before_agent_start`. When a refresh fails or
 *     comes back truncated, the file is marked stale in
 *     `context/working.meta.json` and NOT injected until the next
 *     successful rebuild — a stale intent must not outrank the fresher
 *     default compaction summary in the conversation.
 *   - Reference archive keeps the pre-compaction trajectory in
 *     `context/archive/ctx-NNN.json` with inline base64 images extracted to
 *     `context/archive/assets/` (referenced by path + sha256), indexed by
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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import { renderObservationIndex } from "./observation-index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CadRequirements, CadRunState } from "../shared/protocol.ts";
import { CadProjectStore, CadRunStore, nowIso } from "../shared/store.ts";
import { readJsonLinesTail, readTextPrefix } from "../shared/bounded-files.ts";
import { maybeAutoContinue } from "./continuation.ts";

/** Rebuild threshold in Pi's percent scale (0-100). Experimental initial value. */
const DEFAULT_THRESHOLD_PERCENT = 55;
/** Char budget for the trajectory copy handed to the fresh working-context LLM. */
const DEFAULT_SUMMARIZER_BUDGET_CHARS = 240_000;
/** Hard render cap for working.md inside the system prompt (~4k tokens). */
const WORKING_CONTEXT_MAX_CHARS = 16_000;
/** How many archived checkpoints to list in the system prompt index. */
const ARCHIVE_INDEX_LIMIT = 5;
/**
 * Output budget for the fresh working-context call. On the OpenAI
 * Responses API `max_output_tokens` covers hidden reasoning AND the visible
 * working.md text, so this must leave room for medium-effort reasoning on
 * top of a ~3000-word document — 4096 would truncate mid-document.
 */
const UPDATE_MAX_TOKENS = 8192;

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

interface WorkingMeta {
  status: "active" | "stale";
  updatedAt: string;
  reason?: string;
}

function workingMetaPath(run: CadRunStore): string {
  return join(contextDirOf(run), "working.meta.json");
}

/** Missing/unreadable meta means active: runs predating the marker inject fine. */
async function readWorkingMeta(run: CadRunStore): Promise<WorkingMeta> {
  const meta = await readJson<WorkingMeta>(workingMetaPath(run));
  return meta?.status === "stale" ? meta : { status: "active", updatedAt: "" };
}

/** Meta bookkeeping must never fail a refresh that already succeeded. */
async function tryWriteWorkingMeta(run: CadRunStore, meta: WorkingMeta): Promise<void> {
  try {
    await mkdir(contextDirOf(run), { recursive: true });
    await writeFile(workingMetaPath(run), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  } catch {
    // Non-fatal: default-active read keeps the just-written working.md in play.
  }
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

async function readRecentRefs(run: CadRunStore): Promise<{ refs: ContextRef[]; truncated: boolean }> {
  const result = await readJsonLinesTail<ContextRef>(
    join(contextDirOf(run), "refs.jsonl"),
    256 * 1024,
    ARCHIVE_INDEX_LIMIT,
  );
  return { refs: result.records, truncated: result.truncated };
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
 * Extract inline base64 images from the trajectory into archive asset files
 * and replace the payload with a path + sha256 reference. User-supplied
 * reference images (e.g. "modify this mechanical structure") live ONLY in
 * the session trajectory — Pi-CAD's evidence/ never saw them — so dropping
 * the bytes would lose them irrecoverably. Asset files keep the JSON
 * archive readable while every image stays byte-exact on disk.
 */
async function extractImageAssets(
  run: CadRunStore,
  id: string,
  messages: unknown[],
): Promise<{ messages: unknown[]; assets: Array<{ path: string; sha256: string; bytes: number }> }> {
  const assetsDir = join(contextDirOf(run), "archive", "assets");
  const assets: Array<{ path: string; sha256: string; bytes: number }> = [];
  let seq = 0;

  const extract = async (block: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (block.type !== "image" || typeof block.data !== "string" || !block.data) return block;
    seq += 1;
    const ext = imageAssetExt(block.mimeType);
    const bytes = Buffer.from(block.data, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const name = `${id}-${String(seq).padStart(3, "0")}.${ext}`;
    const relative = `.pi-cad/runs/${run.runId}/context/archive/assets/${name}`;
    await writeFile(join(assetsDir, name), bytes);
    assets.push({ path: relative, sha256, bytes: bytes.byteLength });
    return {
      ...block,
      data: `[archived image asset: ${relative} (sha256=${sha256.slice(0, 16)}…, ${bytes.byteLength} bytes)]`,
      archiveAsset: { path: relative, sha256, bytes: bytes.byteLength },
    };
  };

  const walk = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await walk(item));
      return out;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.type === "image" && typeof record.data === "string") return await extract(record);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record)) out[key] = await walk(item);
      return out;
    }
    return value;
  };

  return { messages: await walk(messages), assets };
}

function imageAssetExt(mimeType: unknown): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

/** User-role texts that are harness-injected nudges, not human input. */
const HARNESS_NUDGE_PREFIXES = ["Pi-CAD workflow is still in"];

/**
 * Deterministic one-line label for the reference index (no extra LLM call).
 * Prefers the most recent human user message, skipping Pi-CAD's own
 * auto-continue nudges — otherwise every checkpoint would be labelled
 * "workflow is still in BUILD" and the index would carry no information.
 */
function indexSummary(messages: unknown[]): string {
  const userTexts: string[] = [];
  for (const message of messages) {
    const record = message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (record?.role !== "user" || !Array.isArray(record.content)) continue;
    const text = record.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) userTexts.push(text);
  }
  const meaningful = userTexts.filter(
    (text) => !HARNESS_NUDGE_PREFIXES.some((prefix) => text.startsWith(prefix)),
  );
  const chosen = meaningful[meaningful.length - 1] ?? userTexts[0];
  if (!chosen) return `${messages.length} messages`;
  return chosen.length > 90 ? `${chosen.slice(0, 90)}…` : chosen;
}

/**
 * Allocate the next checkpoint id from BOTH the archive directory and
 * refs.jsonl. Counting refs alone regresses (and would overwrite an
 * existing checkpoint) whenever a torn final JSONL line drops an entry.
 */
async function nextArchiveId(run: CadRunStore): Promise<string> {
  let max = 0;
  try {
    for (const name of await readdir(join(contextDirOf(run), "archive"))) {
      const match = /^ctx-(\d+)\.json$/.exec(name);
      if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
    }
  } catch {
    // No archive directory yet.
  }
  for (const ref of await readRefs(run)) {
    const match = /^ctx-(\d+)$/.exec(ref.id);
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return `ctx-${String(max + 1).padStart(3, "0")}`;
}

interface ArchivedTrajectory {
  ref: ContextRef;
}

async function archiveTrajectory(
  run: CadRunStore,
  messages: unknown[],
  meta: { reason: string; tokensBefore: number; firstKeptEntryId: string },
): Promise<ArchivedTrajectory> {
  await mkdir(join(contextDirOf(run), "archive", "assets"), { recursive: true });
  const id = await nextArchiveId(run);
  const { messages: archivedMessages, assets } = await extractImageAssets(run, id, messages);
  const absolutePath = join(contextDirOf(run), "archive", `${id}.json`);
  const payload = {
    id,
    createdAt: nowIso(),
    reason: meta.reason,
    tokensBefore: meta.tokensBefore,
    firstKeptEntryId: meta.firstKeptEntryId,
    messageCount: messages.length,
    assets,
    messages: archivedMessages,
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
  return { ref };
}

/**
 * A failed refresh must not leave a stale "current brain" competing with
 * the fresher default compaction summary in the conversation: mark the
 * existing working.md stale (skipped at injection until the next
 * successful rebuild) and journal the failure for experiment telemetry.
 */
async function noteUpdateFailure(
  run: CadRunStore,
  info: { stopReason?: string; checkpointId?: string },
): Promise<void> {
  try {
    if (existsSync(workingPath(run))) {
      await tryWriteWorkingMeta(run, {
        status: "stale",
        updatedAt: nowIso(),
        reason: info.stopReason ? `refresh stopped: ${info.stopReason}` : "refresh failed",
      });
    }
    await run.appendEvent("ContextMemoryUpdateFailed", {
      stopReason: info.stopReason ?? null,
      checkpointId: info.checkpointId ?? null,
    });
  } catch {
    // Telemetry and staleness are best-effort; compaction proceeds regardless.
  }
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
 * Reasoning effort for the fresh working-context call. Pi's OpenAI
 * Responses adapter maps an ABSENT reasoningEffort to `off`/`none` — not
 * provider default, not medium — so an explicit value is required for the
 * summarizer to actually reason. `PI_CAD_CONTEXT_MEMORY_REASONING` may set
 * low/medium/high/... or "off"/"none" to disable reasoning deliberately.
 */
function reasoningEffort(): string | undefined {
  const raw = process.env.PI_CAD_CONTEXT_MEMORY_REASONING?.trim().toLowerCase();
  if (!raw) return "medium";
  if (raw === "off" || raw === "none" || raw === "disabled") return undefined;
  return raw;
}

export interface WorkingContextUpdate {
  updated: boolean;
  /** Provider usage of the fresh call, for CompactionEntry accounting. */
  usage?: unknown;
  /** Stop reason when the call resolved but did not finish cleanly. */
  stopReason?: string;
}

/**
 * Refresh working.md with one fresh LLM call over a budgeted copy of the
 * trajectory. Returns updated=false when no model is available or the call
 * fails — callers must then fall back to Pi's default compaction summary
 * (the archive is still written; only the custom summary is skipped).
 */
async function updateWorkingContext(
  ctx: ExtensionContext,
  run: CadRunStore,
  messages: unknown[],
  signal: AbortSignal,
): Promise<WorkingContextUpdate> {
  const model = resolveUpdateModel(ctx);
  if (!model) return { updated: false };
  const registry = ctx.modelRegistry as unknown as {
    complete?: (
      model: unknown,
      request: { messages: Array<Record<string, unknown>> },
      options: Record<string, unknown>,
    ) => Promise<{ content?: Array<{ type?: string; text?: string }>; usage?: unknown; stopReason?: string }>;
  };
  if (!registry.complete) return { updated: false };

  try {
    // The stale quarantine must cover the compactor too: feeding the OLD
    // brain back here would summarize the abandoned intent right into the
    // refreshed one. Stale working context is not passed at all.
    const meta = await readWorkingMeta(run);
    const previous = meta.status === "active" ? (await readText(workingPath(run))).trim() : "";
    const previousNote =
      previous ||
      (meta.status === "stale"
        ? "(previous working context was quarantined as stale after a failed refresh — regenerate from the trajectory alone, do not resurrect it)"
        : "(none yet — this is the first rebuild)");
    const conversation = budgetClip(serializeConversation(convertToLlm(messages as never)));
    const prompt = [
      WORKING_CONTEXT_PROMPT,
      "<previous working context>",
      previousNote,
      "</previous working context>",
      "<trajectory since previous checkpoint>",
      conversation,
      "</trajectory>",
    ].join("\n\n");

    const effort = reasoningEffort();
    const response = await registry.complete(
      model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: UPDATE_MAX_TOKENS,
        signal,
        cacheRetention: "none",
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    );
    const text = (response.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n")
      .trim();
    // A truncated refresh is worse than none: half a document would become
    // the next phase's "current brain" with no indication it is incomplete.
    // complete() only resolves for non-error stops (aborted/error throw in
    // the adapter), so anything but "stop" here means cut off mid-output.
    if (response.stopReason !== "stop") {
      return { updated: false, stopReason: response.stopReason };
    }
    if (!text) return { updated: false };
    await mkdir(contextDirOf(run), { recursive: true });
    await writeFile(workingPath(run), `${text}\n`, "utf-8");
    await tryWriteWorkingMeta(run, { status: "active", updatedAt: nowIso() });
    return { updated: true, usage: response.usage };
  } catch {
    return { updated: false };
  }
}

/**
 * Render the committed brief. Assumptions and openUnknowns are rendered
 * deliberately, labelled as provisional: the topology-optimization failure
 * mode was a tentative volume-fraction assumption hardening into a
 * "constraint" over a long run — the mission must keep saying which claims
 * were never user-verified. Empty sections are omitted.
 */
function renderMission(requirements: CadRequirements): string {
  const sections: Array<[string, string[]]> = [
    ["Must:", requirements.must],
    ["Deliverables:", requirements.deliverables],
    ["Preferences (soft — trade away only with a stated reason):", requirements.preferences],
    ["Assumptions (provisional — NOT user-verified constraints):", requirements.assumptions],
    ["Open Unknowns (unresolved questions):", requirements.openUnknowns],
  ];
  const lines = ["## Mission", "", `Goal: ${requirements.goal}`];
  for (const [label, items] of sections) {
    if (!items?.length) continue;
    lines.push("", label, ...items.map((item) => `- ${item}`));
  }
  if (requirements.assertions?.length) {
    lines.push(
      "",
      "Pre-registered Acceptance Assertions:",
      ...requirements.assertions.map((assertion) =>
        `- ${assertion.id} (${assertion.mustRef}): ${assertion.statement}`,
      ),
    );
  }
  if (requirements.deferredClarifications?.length) {
    lines.push(
      "",
      "Headless Clarification Debt (fallbacks are provisional, not user answers):",
      ...requirements.deferredClarifications.map((item) =>
        `- ${item.question} | fallback: ${item.fallback} | impact: ${item.impact}`,
      ),
    );
  }
  lines.push(
    "",
    "Treat Must as hard constraints and Assumptions as revisable; do not silently promote an assumption into a constraint.",
  );
  return lines.join("\n");
}

/**
 * Render the per-run task context appended to the system prompt:
 * Mission (from the immutable record selected by requirementsVersion) + Working Context (working.md) +
 * a short index of archived checkpoints. Canonical state is NOT summarized
 * here — `composeSystemPrompt()` already re-projects it every turn.
 * Returns "" when nothing exists yet (fresh run).
 */
export async function renderTaskContext(cwd: string, state: CadRunState): Promise<string> {
  const run = new CadRunStore(cwd, state.runId);
  const sections: string[] = [];

  const requirements = state.requirementsVersion
    ? await run.readRequirementsVersion<CadRequirements>(state.requirementsVersion).catch(() => null)
    : await readJson<CadRequirements>(join(run.recordsDir, "requirements.json"));
  if (requirements?.goal) sections.push(renderMission(requirements));

  const lateClarifications = (state.deferredClarifications ?? []).filter(
    (item) => item.phase !== "requirements",
  );
  if (lateClarifications.length) {
    sections.push([
      "## Run-wide Headless Clarification Debt",
      "",
      "These fallbacks are provisional engineering decisions, not user answers:",
      ...lateClarifications.map((item) =>
        `- [${item.phase}] ${item.question} | fallback: ${item.fallback} | impact: ${item.impact}`,
      ),
    ].join("\n"));
  }

  // A stale working.md (refresh failed mid-compaction) is deliberately NOT
  // injected: its "Current intent" would outrank the fresher default
  // compaction summary now carrying the run in the conversation.
  const meta = await readWorkingMeta(run);
  const workingRead = meta.status === "stale"
    ? { text: "", truncated: false }
    : await readTextPrefix(workingPath(run), WORKING_CONTEXT_MAX_CHARS);
  const working = workingRead.text.trim();
  if (working) {
    const note = workingRead.truncated
      ? `\n\n[... working context clipped at ${WORKING_CONTEXT_MAX_CHARS} bytes; full file at context/working.md ...]`
      : "";
    sections.push(`## Working Context\n\n${working}${note}`);
  }

  const review = state.finalReview;
  if (
    review &&
    review.verdict !== "pass" &&
    review.artifactHash === state.currentArtifactHash &&
    review.requirementsHash === state.requirementsVersion &&
    review.assertionsHash === state.assertionsVersion
  ) {
    const report = await readJson<{
      result?: { summary?: string; assertionChecks?: Array<{ assertionId: string; verdict: string; finding: string }> };
    }>(join(cwd, review.path));
    const checks = report?.result?.assertionChecks ?? [];
    sections.push([
      "## Latest independent review",
      "",
      `status: ${review.verdict.toUpperCase()}`,
      `report: ${review.path}`,
      report?.result?.summary ? `summary: ${report.result.summary}` : "",
      ...checks.filter((check) => check.verdict !== "pass").map((check) =>
        `- ${check.assertionId} ${check.verdict.toUpperCase()}: ${check.finding}`,
      ),
    ].filter(Boolean).join("\n"));
  }

  const { refs, truncated: refsTruncated } = await readRecentRefs(run);
  if (refs.length) {
    const index = refs
      .slice(-ARCHIVE_INDEX_LIMIT)
      .reverse()
      .map((ref) => `- ${ref.id} — ${ref.summary}`);
    const archiveNote = refsTruncated
      ? `.pi-cad/runs/${state.runId}/context/archive/ (older checkpoints also available)`
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

  // Phase 8: bounded observation index — the agent's post-compaction map
  // of what it saw (headline facts + where the visuals live).
  const observationIndex = await renderObservationIndex(cwd, state.runId);
  if (observationIndex) sections.push(observationIndex);

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
      // force: the rebuild typically fires on the second+ autonomous
      // continuation of the same phase+artifact version, whose nudge key
      // maybeAutoContinue already consumed — without force this resume is
      // deduped away and the run stalls.
      try {
        await maybeAutoContinue(pi, store, latest, ctx, { force: true });
      } catch (error) {
        // A reload/session replacement can invalidate the extension instance
        // while compact() is still finishing. Never let that expected race
        // become an unhandled rejection that kills the host process. The new
        // runtime's agent_settled hook owns any subsequent continuation.
        await store.appendEvent("ContextContinuationDeferred", {
          phase: latest.phase,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })().catch(() => {
      // Canonical workflow state is already on disk. Compaction continuation
      // is best-effort and must not crash Pi even if diagnostic I/O also fails.
    });
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

    // 1. Archive the trajectory first: pure file I/O, independent of the
    //    LLM below, so a failed update never loses history. Fail-open: a
    //    broken archive must not break compaction itself — falling back to
    //    Pi's default summary would discard the trajectory just the same,
    //    while a stale working.md is still the better continuation.
    let archived: ArchivedTrajectory | null = null;
    try {
      archived = await archiveTrajectory(run, messages, {
        reason: event.reason,
        tokensBefore: event.preparation.tokensBefore,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
      });
    } catch {
      archived = null;
    }

    // 2. Fresh LLM refresh of working.md over a budgeted copy.
    const { updated, usage, stopReason } = await updateWorkingContext(ctx, run, messages, event.signal);
    if (!updated) {
      // Fall back to Pi's default compaction summary; archive + refs above
      // are already durable when they could be written.
      await noteUpdateFailure(run, { stopReason, checkpointId: archived?.ref.id });
      return undefined;
    }

    // 3. Minimal compaction entry: mission, canonical state, and working
    //    context are re-injected by before_agent_start on the next run.
    return {
      compaction: {
        summary: [
          `Pi-CAD context rebuild${archived ? ` (${archived.ref.id})` : ""}.`,
          archived
            ? `Full trajectory archived at ${archived.ref.path}; working context updated at context/working.md.`
            : "WARNING: trajectory archive could not be written; working context updated at context/working.md.",
          "Mission, canonical state, and working context are re-injected in the system prompt — do not re-derive them from this history.",
        ].join(" "),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        ...(usage ? { usage } : {}),
        // Preserve Pi's cumulative file tracking so later compactions and
        // session tooling keep a coherent read/modified file history.
        details: event.preparation.fileOps,
      },
    };
  });
}
