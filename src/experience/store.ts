import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { routeKey, type CadRunState } from "../shared/protocol.ts";
import { nowIso } from "../shared/store.ts";
import { runProcess, spawnDetachedProcess } from "../shared/process-runner.ts";
import {
  EXPERIENCE_SCHEMA_VERSION,
  SCORE_VERSION,
  type BenchmarkEvaluation,
  type DistillState,
  type ExperienceIndexEntry,
  type ExperienceMetadata,
  type ExperienceSearchOptions,
  type HumanEvaluation,
} from "./types.ts";
import { renderExperienceView } from "./view.ts";

const DEFAULT_THRESHOLD = 250_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function canonicalizeJsonl(raw: string): string {
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return stable(JSON.parse(line)); } catch { return line; }
  }).join("\n") + "\n";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function archiveTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

export function experienceRoot(): string {
  return resolve(process.env.PI_CAD_EXPERIENCE_ROOT || join(homedir(), ".cad", "transcripts"));
}

export function estimateTranscriptTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) char.charCodeAt(0) < 128 ? ascii++ : nonAscii++;
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}

function analyzerProject(): string {
  return resolve(process.env.PI_CAD_TRANSCRIPT_ANALYZER_PROJECT || fileURLToPath(
    new URL("../../packages/prime-transcript-lab", import.meta.url),
  ));
}

function analyzerEnvironment(): string {
  return resolve(process.env.PI_CAD_TRANSCRIPT_ANALYZER_ENV || join(homedir(), ".cache", "pi-cad", "prime-transcript-lab-venv"));
}

async function runAnalyzer(sessionPath: string, output: string): Promise<void> {
  const project = analyzerProject();
  await stat(join(project, "pyproject.toml"));
  const result = await runProcess({
    command: "uv",
    args: ["run", "--project", project, "prime-trace", sessionPath, "--scan-dir", dirname(sessionPath), "-o", output],
    cwd: project,
    timeoutMs: Number(process.env.PI_CAD_TRANSCRIPT_ANALYZER_TIMEOUT_MS || 300_000),
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: analyzerEnvironment() },
  });
  if (result.exitCode !== 0) throw new Error(`prime-trace exited ${result.exitCode}: ${result.stderr.trim()}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

export async function readIndex(root = experienceRoot()): Promise<ExperienceIndexEntry[]> {
  try {
    const raw = await readFile(join(root, "index.jsonl"), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ExperienceIndexEntry);
  } catch { return []; }
}

async function writeIndex(entries: ExperienceIndexEntry[], root = experienceRoot()): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  await atomicWrite(join(root, "index.jsonl"), sorted.map((entry) => JSON.stringify(entry)).join("\n") + (sorted.length ? "\n" : ""));
}

async function upsertIndex(entry: ExperienceIndexEntry, root = experienceRoot()): Promise<void> {
  const entries = await readIndex(root);
  const index = entries.findIndex((candidate) => candidate.sha === entry.sha);
  if (index >= 0) entries[index] = entry; else entries.push(entry);
  await writeIndex(entries, root);
}

function metricNumber(metrics: Record<string, any> | null, path: string[]): number | null {
  let value: any = metrics;
  for (const key of path) value = value?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function indexFrom(metadata: ExperienceMetadata, metrics: Record<string, any> | null, evaluation: HumanEvaluation, transcriptTokens: number): ExperienceIndexEntry {
  return {
    ...metadata,
    quality: evaluation.quality,
    difficulty: evaluation.difficulty,
    score: evaluation.score,
    score_version: evaluation.score_version,
    transcript_tokens: transcriptTokens,
    processed_tokens: metricNumber(metrics, ["summary", "root_usage", "total"]),
    duration_s: metricNumber(metrics, ["summary", "root_wall_time_s"]),
    evaluation_status: evaluation.quality === null ? "pending" : "evaluated",
    benchmark_evaluation: null,
  };
}

export interface FinalizeExperienceInput {
  state?: CadRunState;
  runId?: string;
  workflow?: string;
  projectPath: string;
  sessionPath: string;
  model?: string;
  reasoning?: string;
  outcome?: "complete" | "clarification_required" | "incomplete";
  outcomeReason?: string;
}

export async function finalizeExperience(input: FinalizeExperienceInput): Promise<ExperienceIndexEntry> {
  const root = experienceRoot();
  await mkdir(root, { recursive: true });
  const raw = await readFile(input.sessionPath, "utf8");
  const digest = sha256(canonicalizeJsonl(raw));
  const existing = (await readIndex(root)).find((entry) => entry.sha === digest);
  if (existing) return existing;
  const seq = Math.max(0, ...(await readIndex(root)).map((entry) => entry.seq)) + 1;
  const timestamp = nowIso();
  const workflow = input.workflow ?? (input.state?.route ? routeKey(input.state.route) : "unknown");
  const runId = input.runId ?? input.state?.runId;
  if (!runId) throw new Error("experience archival requires runId");
  const projectName = basename(resolve(input.projectPath));
  const archive = join(root, sanitizeSegment(workflow), sanitizeSegment(projectName), archiveTimestamp(timestamp), digest);
  await mkdir(archive, { recursive: true });
  await copyFile(input.sessionPath, join(archive, "transcript.jsonl"));

  const metadata: ExperienceMetadata = {
    schema_version: EXPERIENCE_SCHEMA_VERSION,
    seq,
    run_id: runId,
    workflow,
    project_name: projectName,
    project_path: resolve(input.projectPath),
    timestamp,
    sha: digest,
    archive_path: archive,
    session_path: resolve(input.sessionPath),
    model: input.model || null,
    reasoning: input.reasoning || null,
    analysis_status: "pending",
    outcome: input.outcome,
    outcome_reason: input.outcomeReason,
  };
  await atomicWrite(join(archive, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");

  // Keep the original transcript and full forensic report for audit, but build
  // a separate retrieval view that cannot recursively inject harness policy,
  // skill manuals, phase cards, or earlier experience-search output.
  const experienceView = renderExperienceView(raw, {
    workflow,
    outcome: input.outcome,
    outcomeReason: input.outcomeReason,
    model: input.model,
    reasoning: input.reasoning,
  });
  await atomicWrite(join(archive, "experience.md"), experienceView);

  try {
    await runAnalyzer(input.sessionPath, archive);
    for (const required of ["report.html", "transcript.md", "metrics.json", "events.jsonl"]) {
      if ((await stat(join(archive, required))).size === 0) throw new Error(`analyzer produced empty ${required}`);
    }
    metadata.analysis_status = "complete";
  } catch (error) {
    metadata.analysis_status = "failed";
    metadata.analysis_error = error instanceof Error ? error.message : String(error);
  }
  await atomicWrite(join(archive, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  const evaluation: HumanEvaluation = {
    schema_version: EXPERIENCE_SCHEMA_VERSION,
    quality: null,
    difficulty: null,
    score: null,
    score_version: SCORE_VERSION,
    evaluated_at: null,
  };
  await atomicWrite(join(archive, "evaluation.json"), JSON.stringify(evaluation, null, 2) + "\n");
  const metrics = await readJson<Record<string, any>>(join(archive, "metrics.json"));
  const entry = indexFrom(metadata, metrics, evaluation, estimateTranscriptTokens(experienceView));
  await upsertIndex(entry, root);
  return entry;
}

export function computeScore(entry: ExperienceIndexEntry, quality: number, difficulty: number): number {
  const tokenEfficiency = 1 / (1 + entry.transcript_tokens / 50_000);
  const timeEfficiency = entry.duration_s === null ? 0.5 : 1 / (1 + entry.duration_s / 600);
  return Math.round((70 * quality / 5 + 15 * difficulty / 5 + 8 * tokenEfficiency + 7 * timeEfficiency) * 10) / 10;
}

function validateRating(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`${name} must be an integer from 1 to 5`);
}

export async function recordEvaluation(identifier: { seq?: number; sha?: string }, quality: number, difficulty: number): Promise<ExperienceIndexEntry> {
  validateRating("quality", quality);
  validateRating("difficulty", difficulty);
  const root = experienceRoot();
  const entries = await readIndex(root);
  const entry = entries.find((candidate) => identifier.seq !== undefined ? candidate.seq === identifier.seq : candidate.sha === identifier.sha);
  if (!entry) throw new Error("experience trajectory not found");
  const wasPending = entry.evaluation_status === "pending";
  const evaluation: HumanEvaluation = {
    schema_version: EXPERIENCE_SCHEMA_VERSION,
    quality,
    difficulty,
    score: computeScore(entry, quality, difficulty),
    score_version: SCORE_VERSION,
    evaluated_at: nowIso(),
  };
  await atomicWrite(join(entry.archive_path, "evaluation.json"), JSON.stringify(evaluation, null, 2) + "\n");
  const updated = { ...entry, ...evaluation, evaluation_status: "evaluated" as const };
  await upsertIndex(updated, root);
  if (wasPending) await addPendingTokens(updated.seq, updated.transcript_tokens, root);
  return updated;
}

export interface RecordBenchmarkEvaluationInput {
  benchmark: string;
  partition?: string | null;
  sample_id: string;
  passed: number;
  total: number;
  exact_pass: boolean;
  rs_passed: number;
  rs_total: number;
  integrity_status: "clean" | "toolchain" | "flagged";
  failures?: Array<{
    requirement_id: string;
    description: string;
    message: string;
  }>;
}

/** Record evaluator-owned benchmark authority without impersonating a human rating. */
export async function recordBenchmarkEvaluation(
  identifier: { seq?: number; sha?: string },
  input: RecordBenchmarkEvaluationInput,
): Promise<ExperienceIndexEntry> {
  const integers = [input.passed, input.total, input.rs_passed, input.rs_total];
  if (integers.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("benchmark counts must be non-negative integers");
  if (input.total === 0 || input.passed > input.total || input.rs_passed > input.rs_total) throw new Error("invalid benchmark totals");
  if (!input.benchmark.trim() || !input.sample_id.trim()) throw new Error("benchmark and sample_id are required");
  const root = experienceRoot();
  const entries = await readIndex(root);
  const entry = entries.find((candidate) => identifier.seq !== undefined ? candidate.seq === identifier.seq : candidate.sha === identifier.sha);
  if (!entry) throw new Error("experience trajectory not found");
  const evaluation: BenchmarkEvaluation = {
    schema_version: EXPERIENCE_SCHEMA_VERSION,
    benchmark: input.benchmark.trim(),
    partition: input.partition?.trim() || null,
    sample_id: input.sample_id.trim(),
    passed: input.passed,
    total: input.total,
    exact_pass: input.exact_pass,
    rs_passed: input.rs_passed,
    rs_total: input.rs_total,
    integrity_status: input.integrity_status,
    failures: (input.failures || []).slice(0, 32).map((failure) => ({
      requirement_id: String(failure.requirement_id || "unknown").slice(0, 160),
      description: String(failure.description || "").slice(0, 1_000),
      message: String(failure.message || "").slice(0, 1_000),
    })),
    score: Math.round(1000 * input.passed / input.total) / 10,
    evaluated_at: nowIso(),
  };
  await atomicWrite(join(entry.archive_path, "benchmark-evaluation.json"), JSON.stringify(evaluation, null, 2) + "\n");
  const wasPending = entry.evaluation_status === "pending";
  const updated: ExperienceIndexEntry = { ...entry, benchmark_evaluation: evaluation, evaluation_status: "evaluated" };
  await upsertIndex(updated, root);
  if (wasPending) await addPendingTokens(updated.seq, updated.transcript_tokens, root);
  return updated;
}

function includes(value: string | null, query: string | undefined): boolean {
  return !query || (value || "").toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "cad", "contract", "create", "for", "from", "gate",
  "in", "into", "mechanical", "model", "of", "on", "or", "part", "python", "release", "source",
  "step", "the", "to", "unit", "units", "using", "with", "workflow", "benchmark", "adversarial",
]);

function lexicalTokens(value: string, removeStopWords = true): string[] {
  const tokens = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = tokens.filter((token) => token.length > 1 && (!removeStopWords || !SEARCH_STOP_WORDS.has(token)));
  return meaningful.length || !removeStopWords ? meaningful : lexicalTokens(value, false);
}

function tokenMatches(query: string, candidate: string): boolean {
  if (query === candidate) return true;
  // A small morphology-tolerant prefix match covers common CAD wording such
  // as rectangle/rectangular and fillet/filleted without an external search
  // service. Short tokens remain exact to avoid noisy accidental matches.
  return query.length >= 6 && candidate.length >= 6 && query.slice(0, 6) === candidate.slice(0, 6);
}

function lexicalRelevance(query: string, metadataText: string, transcript: string): number {
  const terms = [...new Set(lexicalTokens(query))];
  if (!terms.length) return 0;
  const metadataTokens = lexicalTokens(metadataText, false);
  const transcriptTokens = lexicalTokens(transcript, false);
  let matchedTerms = 0;
  let score = 0;
  for (const term of terms) {
    const metadataCount = metadataTokens.filter((candidate) => tokenMatches(term, candidate)).length;
    const transcriptCount = transcriptTokens.filter((candidate) => tokenMatches(term, candidate)).length;
    if (!metadataCount && !transcriptCount) continue;
    matchedTerms++;
    score += Math.min(4, metadataCount) * 8 + Math.min(8, transcriptCount);
  }
  const phrase = query.toLocaleLowerCase().trim();
  if (phrase.length > 2) {
    if (metadataText.toLocaleLowerCase().includes(phrase)) score += 40;
    if (transcript.toLocaleLowerCase().includes(phrase)) score += 20;
  }
  // Coverage dominates repeated boilerplate. A single distinctive term can
  // retrieve a useful trajectory, while matching several terms ranks it well
  // above generic workflow language repeated in every Phase Card.
  return matchedTerms ? score + 25 * matchedTerms / terms.length : 0;
}

async function readRetrievalView(entry: ExperienceIndexEntry): Promise<string> {
  try { return await readFile(join(entry.archive_path, "experience.md"), "utf8"); } catch { /* legacy archive */ }
  try {
    const raw = await readFile(join(entry.archive_path, "transcript.jsonl"), "utf8");
    return renderExperienceView(raw, {
      workflow: entry.workflow,
      outcome: entry.outcome,
      outcomeReason: entry.outcome_reason,
      model: entry.model,
      reasoning: entry.reasoning,
    });
  } catch {
    // Pre-view synthetic/test archives may only have the old Markdown. Real
    // Prime archives retain JSONL and therefore always take the filtered path.
    return await readFile(join(entry.archive_path, "transcript.md"), "utf8");
  }
}

function between(value: number | null, min?: number, max?: number): boolean {
  if (min !== undefined && (value === null || value < min)) return false;
  if (max !== undefined && (value === null || value > max)) return false;
  return true;
}

export async function searchExperience(options: ExperienceSearchOptions = {}): Promise<Array<ExperienceIndexEntry & { relevance?: number }>> {
  const entries = await readIndex();
  const query = options.query?.toLocaleLowerCase().trim();
  const matches: Array<ExperienceIndexEntry & { relevance?: number }> = [];
  for (const entry of entries) {
    if (!includes(entry.workflow, options.workflow) || !includes(entry.project_name, options.project_name) || !includes(entry.project_path, options.project_path) || !includes(entry.model, options.model) || !includes(entry.reasoning, options.reasoning)) continue;
    if (!between(entry.quality, options.min_quality, options.max_quality) || !between(entry.difficulty, options.min_difficulty, options.max_difficulty) || !between(entry.score, options.min_score, options.max_score)) continue;
    if (!between(entry.transcript_tokens, options.min_transcript_tokens, options.max_transcript_tokens) || !between(entry.processed_tokens, options.min_processed_tokens, options.max_processed_tokens) || !between(entry.duration_s, options.min_duration_s, options.max_duration_s)) continue;
    if (options.timestamp_from && entry.timestamp < options.timestamp_from || options.timestamp_to && entry.timestamp > options.timestamp_to) continue;
    if (options.evaluation_status && entry.evaluation_status !== options.evaluation_status) continue;
    const benchmark = entry.benchmark_evaluation ?? null;
    if (options.benchmark && !includes(benchmark?.benchmark ?? null, options.benchmark)) continue;
    if (options.partition && !includes(benchmark?.partition ?? null, options.partition)) continue;
    if (options.sample_id && !includes(benchmark?.sample_id ?? null, options.sample_id)) continue;
    if (!between(benchmark?.score ?? null, options.min_benchmark_score, options.max_benchmark_score)) continue;
    if (options.benchmark_exact_pass !== undefined && benchmark?.exact_pass !== options.benchmark_exact_pass) continue;
    let relevance = 0;
    if (query) {
      const failureText = (benchmark?.failures || []).map((failure) => `${failure.requirement_id}\n${failure.description}\n${failure.message}`).join("\n");
      const metadataText = `${entry.project_name}\n${entry.project_path}\n${entry.workflow}\n${benchmark?.benchmark ?? ""}\n${benchmark?.sample_id ?? ""}\n${failureText}`.toLocaleLowerCase();
      let transcript = "";
      try { transcript = await readRetrievalView(entry); } catch { /* unreadable archives remain metadata-searchable */ }
      relevance = lexicalRelevance(query, metadataText, transcript);
      if (relevance === 0) continue;
    }
    matches.push({ ...entry, ...(query ? { relevance } : {}) });
  }
  const sort = options.sort || (query ? "relevance" : "score");
  const order = options.order || "desc";
  matches.sort((a, b) => {
    const av = sort === "benchmark_score" ? a.benchmark_evaluation?.score : (a as any)[sort === "duration" ? "duration_s" : sort];
    const bv = sort === "benchmark_score" ? b.benchmark_evaluation?.score : (b as any)[sort === "duration" ? "duration_s" : sort];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const comparison = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return order === "asc" ? comparison : -comparison;
  });
  return matches.slice(0, Math.min(MAX_LIMIT, Math.max(1, options.limit || DEFAULT_LIMIT)));
}

export async function getExperience(identifier: { seq?: number; sha?: string }): Promise<ExperienceIndexEntry> {
  const entry = (await readIndex()).find((candidate) => identifier.seq !== undefined ? candidate.seq === identifier.seq : candidate.sha === identifier.sha);
  if (!entry) throw new Error("experience trajectory not found");
  return entry;
}

export async function readExperience(identifier: { seq?: number; sha?: string }, startLine = 1, endLine = 400): Promise<{ entry: ExperienceIndexEntry; start_line: number; end_line: number; total_lines: number; text: string }> {
  const entry = await getExperience(identifier);
  const lines = (await readRetrievalView(entry)).split(/\r?\n/);
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.min(lines.length, start + 399, Math.max(start, Math.floor(endLine)));
  return { entry, start_line: start, end_line: end, total_lines: lines.length, text: lines.slice(start - 1, end).join("\n") };
}

export async function findExperience(identifier: { seq?: number; sha?: string }, query: string, context = 2, limit = 20): Promise<Array<{ line: number; start_line: number; end_line: number; text: string }>> {
  if (!query.trim()) throw new Error("query is required");
  const entry = await getExperience(identifier);
  const lines = (await readRetrievalView(entry)).split(/\r?\n/);
  const needle = query.toLocaleLowerCase();
  const terms = [...new Set(lexicalTokens(query))];
  const found = [];
  for (let index = 0; index < lines.length && found.length < Math.min(100, Math.max(1, limit)); index++) {
    const haystack = lines[index].toLocaleLowerCase();
    const lineTokens = lexicalTokens(haystack, false);
    if (!haystack.includes(needle) && !terms.some((term) => lineTokens.some((candidate) => tokenMatches(term, candidate)))) continue;
    const start = Math.max(0, index - Math.max(0, context));
    const end = Math.min(lines.length, index + Math.max(0, context) + 1);
    found.push({ line: index + 1, start_line: start + 1, end_line: end, text: lines.slice(start, end).join("\n") });
  }
  return found;
}

async function defaultDistillState(): Promise<DistillState> {
  const configured = Number(process.env.PI_CAD_DISTILL_THRESHOLD_TOKENS || DEFAULT_THRESHOLD);
  return {
    schema_version: EXPERIENCE_SCHEMA_VERSION,
    last_distilled_seq: 0,
    pending_transcript_tokens: 0,
    threshold_tokens: Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_THRESHOLD,
    last_distilled_at: null,
    active_cutoff_seq: null,
    active_started_at: null,
  };
}

export async function readDistillState(root = experienceRoot()): Promise<DistillState> {
  return await readJson<DistillState>(join(root, "distill_state.json")) || await defaultDistillState();
}

async function addPendingTokens(seq: number, tokens: number, root: string): Promise<void> {
  const state = await readDistillState(root);
  if (seq <= state.last_distilled_seq) return;
  const entries = await readIndex(root);
  state.pending_transcript_tokens = entries.filter((entry) => entry.seq > state.last_distilled_seq && entry.evaluation_status === "evaluated").reduce((sum, entry) => sum + entry.transcript_tokens, 0);
  await atomicWrite(join(root, "distill_state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function beginDistillation(root: string, requireThreshold: boolean): Promise<{ triggered: boolean; cutoff_seq?: number; request_path?: string }> {
  const state = await readDistillState(root);
  if ((requireThreshold && state.pending_transcript_tokens < state.threshold_tokens) || state.pending_transcript_tokens <= 0 || state.active_cutoff_seq !== null) return { triggered: false };
  const lockPath = join(root, "distill.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); } catch { return { triggered: false }; }
  await lock.close();
  const evaluated = (await readIndex(root)).filter((entry) => entry.seq > state.last_distilled_seq && entry.evaluation_status === "evaluated");
  const cutoff = Math.max(state.last_distilled_seq, ...evaluated.map((entry) => entry.seq));
  state.active_cutoff_seq = cutoff;
  state.active_started_at = nowIso();
  await atomicWrite(join(root, "distill_state.json"), JSON.stringify(state, null, 2) + "\n");
  const requestPath = join(root, `distill-${state.last_distilled_seq + 1}-${cutoff}.json`);
  await atomicWrite(requestPath, JSON.stringify({ schema_version: 1, from_seq: state.last_distilled_seq + 1, cutoff_seq: cutoff, transcript_tokens: state.pending_transcript_tokens, created_at: state.active_started_at }, null, 2) + "\n");
  return { triggered: true, cutoff_seq: cutoff, request_path: requestPath };
}

export async function maybeBeginDistillation(root = experienceRoot()): Promise<{ triggered: boolean; cutoff_seq?: number; request_path?: string }> {
  return beginDistillation(root, true);
}

/** Explicit user action: preserve the same lock and immutable cutoff, but do not wait for the automatic token threshold. */
export async function beginDistillationNow(root = experienceRoot()): Promise<{ triggered: boolean; cutoff_seq?: number; request_path?: string }> {
  return beginDistillation(root, false);
}

export async function completeDistillation(success: boolean, root = experienceRoot()): Promise<DistillState> {
  const state = await readDistillState(root);
  if (success && state.active_cutoff_seq !== null) {
    state.last_distilled_seq = state.active_cutoff_seq;
    state.last_distilled_at = nowIso();
  }
  state.active_cutoff_seq = null;
  state.active_started_at = null;
  const entries = await readIndex(root);
  state.pending_transcript_tokens = entries.filter((entry) => entry.seq > state.last_distilled_seq && entry.evaluation_status === "evaluated").reduce((sum, entry) => sum + entry.transcript_tokens, 0);
  await atomicWrite(join(root, "distill_state.json"), JSON.stringify(state, null, 2) + "\n");
  await rm(join(root, "distill.lock"), { force: true });
  return state;
}

/**
 * Launch a detached distillation supervisor. By default it starts upstream
 * Prime with GLM; PI_CAD_DISTILL_COMMAND_JSON remains an argv-array override. The worker
 * owns log capture, cursor advancement on zero exit, and lock cleanup.
 */
export async function runConfiguredDistillation(requestPath: string, root = experienceRoot()): Promise<"queued" | "complete" | "failed"> {
  const raw = process.env.PI_CAD_DISTILL_COMMAND_JSON;
  if (raw) {
    let command: unknown;
    try { command = JSON.parse(raw); } catch { throw new Error("PI_CAD_DISTILL_COMMAND_JSON must be a JSON argv array"); }
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string" || !item)) {
      throw new Error("PI_CAD_DISTILL_COMMAND_JSON must be a non-empty JSON argv array");
    }
  }

  const worker = fileURLToPath(new URL("../../scripts/distill-experience.mjs", import.meta.url));
  await stat(worker);
  spawnDetachedProcess({
    command: process.execPath,
    args: [worker, requestPath, resolve(root), raw || ""],
    cwd: resolve(root),
    env: {
      ...process.env,
      PI_CAD_DISTILL_PROVIDER: process.env.PI_CAD_DISTILL_PROVIDER || "zai",
      PI_CAD_DISTILL_MODEL: process.env.PI_CAD_DISTILL_MODEL || "glm-5.3-flash",
      PI_CAD_DISTILL_THINKING: process.env.PI_CAD_DISTILL_THINKING || "low",
    },
  });
  return "queued";
}
