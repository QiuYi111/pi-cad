/**
 * Observation index (refactor Phase 8: Context Runtime v2).
 *
 * Every ObservationBundle the agent saw (Phase 1) is appended to a
 * per-run JSONL index: headline, facts, artifact binding, and the
 * VISUAL PATHS that carried the engineering signal.
 *
 * Why: after context compaction the conversation no longer contains
 * those observations. The index (bounded, quota-managed) plus
 * visual rehydration lets the agent recover the important engineering
 * visual state without re-running probes.
 *
 * Storage governance:
 *   - the index itself is capped (head trimmed to RETAIN when it
 *     exceeds MAX);
 *   - images are NEVER copied — the index references evidence paths
 *     by path+hash, so retention rides the existing per-run evidence
 *     directories and adds zero bytes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ObservationBundle } from "../observations/bundle.ts";

const MAX_OBSERVATION_RECORDS = 400;
const RETAIN_OBSERVATION_RECORDS = 300;

export interface ObservationRecord {
  id: number;
  ts: string;
  phase: string;
  /** Agent-facing tool that produced the observation (cad_probe, ...). */
  tool: string;
  /** Backend tool from the envelope (cad_inspect_geometry, ...). */
  backendTool: string;
  ok: boolean;
  headline: string;
  facts: Array<{ key: string; value: string }>;
  visuals: Array<{ name: string; path: string }>;
  artifactHash?: string;
  evidenceKind?: string;
}

export interface ObservationIndexQuery {
  tool?: string;
  evidenceKind?: string;
  artifactHash?: string;
  okOnly?: boolean;
  withVisualsOnly?: boolean;
  limit?: number;
}

function indexDir(cwd: string, runId: string): string {
  return join(cwd, ".pi-cad", "runs", runId, "context");
}

function indexPath(cwd: string, runId: string): string {
  return join(indexDir(cwd, runId), "observations.jsonl");
}

export async function readObservations(
  cwd: string,
  runId: string,
): Promise<ObservationRecord[]> {
  let raw: string;
  try {
    raw = await readFile(indexPath(cwd, runId), "utf-8");
  } catch {
    return [];
  }
  const records: ObservationRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ObservationRecord);
    } catch {
      // Tolerate a torn final line from an interrupted append.
    }
  }
  return records;
}

export interface RecordObservationInput {
  cwd: string;
  runId: string;
  phase: string;
  tool: string;
  bundle: ObservationBundle;
  artifactHash?: string;
  evidenceKind?: string;
}

/** Append one observation; trim the index to its quota. Fails open. */
export async function recordObservation(input: RecordObservationInput): Promise<void> {
  try {
    const records = await readObservations(input.cwd, input.runId);
    const nextId = records.length > 0 ? records[records.length - 1].id + 1 : 1;
    const record: ObservationRecord = {
      id: nextId,
      ts: new Date().toISOString(),
      phase: input.phase,
      tool: input.tool,
      backendTool: input.bundle.tool,
      ok: input.bundle.ok,
      headline: input.bundle.headline,
      facts: input.bundle.facts.slice(0, 40),
      visuals: input.bundle.visuals.map((v) => ({ name: v.name, path: v.path })),
      ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
    };
    const kept = records.length >= MAX_OBSERVATION_RECORDS
      ? records.slice(records.length - RETAIN_OBSERVATION_RECORDS)
      : records;
    // Re-numbering after a trim would break nothing (ids are opaque), but
    // stable ids are easier to cite; keep them as-is.
    const lines = [...kept, record].map((r) => JSON.stringify(r)).join("\n");
    await mkdir(indexDir(input.cwd, input.runId), { recursive: true });
    await writeFile(indexPath(input.cwd, input.runId), `${lines}\n`, "utf-8");
  } catch {
    // The index is an accelerator, never a gate: observation recording
    // must not fail a tool result.
  }
}

/** Query the index (newest first by default). */
export async function queryObservations(
  cwd: string,
  runId: string,
  query: ObservationIndexQuery = {},
): Promise<ObservationRecord[]> {
  const limit = query.limit ?? 20;
  let records = await readObservations(cwd, runId);
  if (query.tool) records = records.filter((r) => r.tool === query.tool);
  if (query.evidenceKind) records = records.filter((r) => r.evidenceKind === query.evidenceKind);
  if (query.artifactHash) records = records.filter((r) => r.artifactHash === query.artifactHash);
  if (query.okOnly) records = records.filter((r) => r.ok);
  if (query.withVisualsOnly) records = records.filter((r) => r.visuals.length > 0);
  return records.slice(-limit).reverse();
}

/** Visual rehydration: paths of the most recent observations' images. */
export async function rehydrateVisuals(
  cwd: string,
  runId: string,
  query: ObservationIndexQuery = {},
): Promise<Array<{ record: ObservationRecord; paths: string[] }>> {
  const records = await queryObservations(cwd, runId, { ...query, withVisualsOnly: true });
  return records.map((record) => ({
    record,
    paths: record.visuals.map((v) => v.path),
  }));
}

/** Compact textual index for the system prompt (bounded). */
export async function renderObservationIndex(
  cwd: string,
  runId: string,
  limit = 8,
): Promise<string> {
  const records = await queryObservations(cwd, runId, { okOnly: true, limit });
  if (records.length === 0) return "";
  const lines = records.map(
    (r) =>
      `- #${r.id} [${r.phase}] ${r.tool}: ${r.headline.slice(0, 120)}` +
      (r.visuals.length ? ` (${r.visuals.length} views)` : ""),
  );
  return [
    "## Recent Observations",
    "",
    ...lines,
    "",
    "After compaction, recover engineering visuals with cad_recall_observation.",
  ].join("\n");
}
