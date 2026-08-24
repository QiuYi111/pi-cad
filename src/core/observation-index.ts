/**
 * Observation index (refactor Phase 8: Context Runtime v2).
 *
 * Every ObservationBundle the agent saw is stored once as an immutable,
 * compressed payload plus a compact per-run discovery record.
 *
 * Why: after context compaction the conversation no longer contains
 * those observations. The compact index supports discovery; the complete
 * payload and its queryable collections remain recoverable without
 * re-running probes. Images are referenced by path+hash and are not copied.
 */
import { createHash } from "node:crypto";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ObservationBundle } from "../observations/bundle.ts";
import { readJsonLinesTail } from "../shared/bounded-files.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ObservationCollectionDescriptor {
  name: string;
  count: number;
  fields: string[];
  defaultOrder: Array<{ field: string; direction: "asc" | "desc" }>;
}

export interface ObservationSnapshot {
  schema: 1;
  observationId: string;
  createdAt: string;
  tool: string;
  preset?: string;
  resolvedSubjects?: Array<{ source: string; path: string; sha256?: string }>;
  headline: string;
  facts: Array<{ key: string; value: string }>;
  visuals: Array<{ name: string; path: string; sha256?: string }>;
  diagnostics: Array<{ level: "info" | "warning" | "error"; message: string }>;
  provenance: ObservationBundle["provenance"];
  artifactHash?: string;
  evidenceKind?: string;
  collections: ObservationCollectionDescriptor[];
  payloadRef: string;
  payloadBytes: number;
}

export interface ObservationRecord {
  id: number;
  observationId?: string;
  ts: string;
  phase: string;
  /** Agent-facing tool that produced the observation (cad_probe, ...). */
  tool: string;
  /** Backend tool from the envelope (cad_inspect_geometry, ...). */
  backendTool: string;
  ok: boolean;
  headline: string;
  facts: Array<{ key: string; value: string }>;
  visuals: Array<{ name: string; path: string; sha256?: string }>;
  artifactHash?: string;
  evidenceKind?: string;
  collections?: ObservationCollectionDescriptor[];
  detailAvailable?: boolean;
  payloadBytes?: number;
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
  preset?: string;
  resolvedSubjects?: Array<{ source: string; path: string; sha256?: string }>;
  rawPayload?: unknown;
}

/** Persist one immutable full observation and append its compact discovery record. */
export async function recordObservation(input: RecordObservationInput): Promise<ObservationRecord> {
    const records = await readObservations(input.cwd, input.runId);
    const nextId = records.length > 0 ? records[records.length - 1].id + 1 : 1;
    const observationId = `obs-${String(nextId).padStart(6, "0")}`;
    const payload = { bundle: input.bundle, payload: input.rawPayload ?? null };
    const collections = collectObservationCollections(input.rawPayload ?? input.bundle);
    const snapshotDir = observationSnapshotDir(input.cwd, input.runId, observationId);
    const payloadPath = join(snapshotDir, "payload.json.gz");
    const payloadRef = `.pi-cad/runs/${input.runId}/context/observations/${observationId}/payload.json.gz`;
    const compressedPayload = await gzipAsync(Buffer.from(JSON.stringify(payload)));
    const quotaBytes = Number(process.env.PI_CAD_OBSERVATION_QUOTA_BYTES ?? 2 * 1024 ** 3);
    const usedBytes = (await Promise.all(records.map(async (record) => {
      if (typeof record.payloadBytes === "number") return record.payloadBytes;
      if (!record.observationId) return 0;
      try { return (await stat(join(observationSnapshotDir(input.cwd, input.runId, record.observationId), "payload.json.gz"))).size; }
      catch { return 0; }
    }))).reduce((sum, size) => sum + size, 0);
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0 || usedBytes + compressedPayload.length > quotaBytes) {
      throw new Error(`observation quota exceeded: need ${compressedPayload.length} bytes with ${usedBytes}/${quotaBytes} already used; complete payload was not silently discarded`);
    }
    const snapshot: ObservationSnapshot = {
      schema: 1,
      observationId,
      createdAt: new Date().toISOString(),
      tool: input.tool,
      ...(input.preset ? { preset: input.preset } : {}),
      ...(input.resolvedSubjects?.length ? { resolvedSubjects: input.resolvedSubjects } : {}),
      headline: input.bundle.headline,
      facts: input.bundle.facts,
      visuals: input.bundle.visuals.map((visual) => {
        const artifact = input.bundle.artifacts.find((item) => item.path === visual.path);
        const sha256 = artifact?.sha256 ?? input.bundle.provenance.outputHashes[visual.path];
        return { ...visual, ...(sha256 ? { sha256 } : {}) };
      }),
      diagnostics: input.bundle.diagnostics,
      provenance: input.bundle.provenance,
      ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      collections: collections.map(({ name, items }) => {
        const fields = collectionFields(items);
        return { name, count: items.length, fields, defaultOrder: fields.includes("line") ? [{ field: "line", direction: "asc" as const }] : [] };
      }),
      payloadRef,
      payloadBytes: compressedPayload.length,
    };
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(payloadPath, compressedPayload, { flag: "wx" });
    await writeFile(join(snapshotDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });

    const record: ObservationRecord = {
      id: nextId,
      observationId,
      ts: snapshot.createdAt,
      phase: input.phase,
      tool: input.tool,
      backendTool: input.bundle.tool,
      ok: input.bundle.ok,
      headline: input.bundle.headline,
      facts: input.bundle.facts.slice(0, 40),
      visuals: input.bundle.visuals.map((v) => {
        const artifact = input.bundle.artifacts.find((item) => item.path === v.path);
        const sha256 = artifact?.sha256 ?? input.bundle.provenance.outputHashes[v.path];
        return { name: v.name, path: v.path, ...(sha256 ? { sha256 } : {}) };
      }),
      ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      collections: snapshot.collections,
      detailAvailable: true,
      payloadBytes: compressedPayload.length,
    };
    const lines = [...records, record].map((r) => JSON.stringify(r)).join("\n");
    await mkdir(indexDir(input.cwd, input.runId), { recursive: true });
    await writeFile(indexPath(input.cwd, input.runId), `${lines}\n`, "utf-8");
    return record;
}

function observationSnapshotDir(cwd: string, runId: string, observationId: string): string {
  return join(indexDir(cwd, runId), "observations", observationId);
}

function collectObservationCollections(value: unknown): Array<{ name: string; items: unknown[] }> {
  const result: Array<{ name: string; items: unknown[] }> = [];
  const visit = (current: unknown, path: string, depth: number) => {
    if (Array.isArray(current)) {
      result.push({ name: path || "result", items: current });
      return;
    }
    if (!current || typeof current !== "object" || depth > 2) return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if ((key === "stdout" || key === "stderr") && typeof child === "string") {
        result.push({ name: next, items: child.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line })) });
      } else {
        visit(child, next, depth + 1);
      }
    }
  };
  visit(value, "", 0);
  return result;
}

function collectionFields(items: unknown[]): string[] {
  const fields = new Set<string>();
  for (const item of items.slice(0, 20)) {
    if (item && typeof item === "object" && !Array.isArray(item)) Object.keys(item as Record<string, unknown>).forEach((key) => fields.add(key));
    else fields.add("value");
  }
  return [...fields].sort();
}

export async function readObservationSnapshot(cwd: string, runId: string, observationId: string): Promise<ObservationSnapshot | null> {
  try {
    return JSON.parse(await readFile(join(observationSnapshotDir(cwd, runId, observationId), "snapshot.json"), "utf-8")) as ObservationSnapshot;
  } catch {
    return null;
  }
}

export interface ObservationCollectionQuery {
  where?: Array<{ field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains"; value: unknown }>;
  fields?: string[];
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  cursor?: string;
  limit?: number;
}

export async function queryObservationCollection(
  cwd: string,
  runId: string,
  observationId: string,
  collection: string,
  query: ObservationCollectionQuery = {},
) {
  const snapshot = await readObservationSnapshot(cwd, runId, observationId);
  if (!snapshot) throw new Error(`unknown observationId: ${observationId}`);
  if (!snapshot.collections.some((item) => item.name === collection)) throw new Error(`unknown observation collection: ${collection}`);
  const compressed = await readFile(join(observationSnapshotDir(cwd, runId, observationId), "payload.json.gz"));
  const stored = JSON.parse((await gunzipAsync(compressed)).toString("utf-8")) as { payload?: unknown; bundle?: unknown };
  const collections = collectObservationCollections(stored.payload ?? stored.bundle);
  let items = collections.find((item) => item.name === collection)?.items ?? [];
  for (const predicate of query.where ?? []) items = items.filter((item) => matchesPredicate(item, predicate));
  const orderBy = query.orderBy ?? snapshot.collections.find((item) => item.name === collection)?.defaultOrder ?? [];
  if (orderBy.length) items = [...items].sort((a, b) => compareItems(a, b, orderBy));
  const signature = createHash("sha256").update(JSON.stringify({ observationId, collection, where: query.where ?? [], fields: query.fields ?? [], orderBy })).digest("hex");
  const offset = decodeCursor(query.cursor, signature);
  const limit = Math.max(1, Math.min(200, query.limit ?? 50));
  const page = items.slice(offset, offset + limit).map((item) => projectFields(item, query.fields));
  const nextOffset = offset + page.length;
  return {
    observationId,
    collection,
    totalMatched: items.length,
    items: page,
    nextCursor: nextOffset < items.length ? Buffer.from(JSON.stringify({ offset: nextOffset, signature })).toString("base64url") : undefined,
    remaining: Math.max(0, items.length - nextOffset),
  };
}

function fieldValue(item: unknown, field: string): unknown {
  if (field === "value" && (item === null || typeof item !== "object")) return item;
  let current: unknown = item;
  for (const part of field.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesPredicate(item: unknown, predicate: NonNullable<ObservationCollectionQuery["where"]>[number]): boolean {
  const actual = fieldValue(item, predicate.field);
  if (predicate.op === "eq") return actual === predicate.value;
  if (predicate.op === "ne") return actual !== predicate.value;
  if (predicate.op === "contains") return String(actual ?? "").includes(String(predicate.value ?? ""));
  if (predicate.op === "lt") return (actual as number) < (predicate.value as number);
  if (predicate.op === "lte") return (actual as number) <= (predicate.value as number);
  if (predicate.op === "gt") return (actual as number) > (predicate.value as number);
  return (actual as number) >= (predicate.value as number);
}

function compareItems(a: unknown, b: unknown, orderBy: NonNullable<ObservationCollectionQuery["orderBy"]>): number {
  for (const order of orderBy) {
    const av = fieldValue(a, order.field) as string | number | undefined;
    const bv = fieldValue(b, order.field) as string | number | undefined;
    const comparison = av === bv ? 0 : av === undefined ? -1 : bv === undefined ? 1 : av < bv ? -1 : 1;
    if (comparison) return order.direction === "desc" ? -comparison : comparison;
  }
  return 0;
}

function projectFields(item: unknown, fields?: string[]): unknown {
  if (!fields?.length) return item;
  return Object.fromEntries(fields.map((field) => [field, fieldValue(item, field)]));
}

function decodeCursor(cursor: string | undefined, signature: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as { offset?: number; signature?: string };
    if (decoded.signature !== signature || !Number.isInteger(decoded.offset) || (decoded.offset ?? -1) < 0) throw new Error("mismatch");
    return decoded.offset!;
  } catch {
    throw new Error("invalid or query-mismatched observation cursor");
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
  const recent = await readJsonLinesTail<ObservationRecord>(indexPath(cwd, runId), 512 * 1024, 256);
  const records = recent.records.filter((record) => record.ok).slice(-limit).reverse();
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
