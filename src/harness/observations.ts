import { createHash, randomUUID } from "node:crypto";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import { canonicalDigest, jsonValue, type JsonValue } from "./canonical.ts";
import type { RegistrySet } from "./registry.ts";
import { HarnessRunStoreV7 } from "./run-store.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ObservationCollectionDescriptorV7 {
  name: string;
  count: number;
  fields: string[];
  defaultOrder: Array<{ field: string; direction: "asc" | "desc" }>;
}

export interface ObservationSnapshotV7 {
  schema: 1;
  id: string;
  tool: string;
  phase: string;
  preset?: string;
  subjectHash?: string;
  evidenceKind?: string;
  resolvedSubjects?: Array<{ source: string; path: string; sha256?: string }>;
  headline: string;
  facts: Array<{ key: string; value: JsonValue }>;
  visuals: Array<{ name: string; path: string; sha256: string }>;
  diagnostics: Array<{ level: "info" | "warning" | "error"; message: string }>;
  provenance: JsonValue;
  collections?: ObservationCollectionDescriptorV7[];
  payloadRef?: string;
  payloadDigest?: string;
  payloadBytes?: number;
  createdAt: string;
  digest: string;
}

export interface ObservationRefV1 {
  schema: 1;
  id: string;
  tool: string;
  phase: string;
  preset?: string;
  headline: string;
  subjectHash?: string;
  evidenceKind?: string;
  snapshotRef: string;
  snapshotDigest: string;
  payloadRef?: string;
  payloadDigest?: string;
  payloadBytes?: number;
  collections: ObservationCollectionDescriptorV7[];
  visualCount: number;
  createdAt: string;
}

export interface ObservationIndexV1 {
  schema: 1;
  capacity: number;
  total: number;
  totalPayloadBytes?: number;
  entries: ObservationRefV1[];
}

export interface ObservationCollectionQueryV7 {
  where?: Array<{ field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains"; value: unknown }>;
  fields?: string[];
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  cursor?: string;
  limit?: number;
}

interface StoredObservationPayloadV1 {
  schema: 1;
  observationId: string;
  payload: JsonValue;
}

function collectionFields(items: unknown[]): string[] {
  const fields = new Set<string>();
  for (const item of items.slice(0, 32)) {
    if (item && typeof item === "object" && !Array.isArray(item)) Object.keys(item as Record<string, unknown>).forEach((key) => fields.add(key));
    else fields.add("value");
  }
  return [...fields].sort();
}

function collectCollections(value: unknown): Array<{ name: string; items: unknown[] }> {
  const result: Array<{ name: string; items: unknown[] }> = [];
  const visit = (current: unknown, path: string, depth: number) => {
    if (Array.isArray(current)) {
      result.push({ name: path || "result", items: current });
      return;
    }
    if (!current || typeof current !== "object" || depth > 8) return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if ((key === "stdout" || key === "stderr") && typeof child === "string") {
        result.push({ name: next, items: child.split(/\r?\n/).map((text, index) => ({ line: index + 1, text })) });
      } else visit(child, next, depth + 1);
    }
  };
  visit(value, "", 0);
  return result;
}

function descriptors(collections: Array<{ name: string; items: unknown[] }>): ObservationCollectionDescriptorV7[] {
  return collections.map(({ name, items }) => {
    const fields = collectionFields(items);
    return { name, count: items.length, fields, defaultOrder: fields.includes("line") ? [{ field: "line", direction: "asc" }] : [] };
  });
}

export function observationRef(snapshot: ObservationSnapshotV7, snapshotRef?: string): ObservationRefV1 {
  return {
    schema: 1,
    id: snapshot.id,
    tool: snapshot.tool,
    phase: snapshot.phase,
    ...(snapshot.preset ? { preset: snapshot.preset } : {}),
    headline: snapshot.headline,
    ...(snapshot.subjectHash ? { subjectHash: snapshot.subjectHash } : {}),
    ...(snapshot.evidenceKind ? { evidenceKind: snapshot.evidenceKind } : {}),
    snapshotRef: snapshotRef ?? `observations/${snapshot.id}/snapshot.json`,
    snapshotDigest: snapshot.digest,
    ...(snapshot.payloadRef ? { payloadRef: snapshot.payloadRef } : {}),
    ...(snapshot.payloadDigest ? { payloadDigest: snapshot.payloadDigest } : {}),
    ...(snapshot.payloadBytes !== undefined ? { payloadBytes: snapshot.payloadBytes } : {}),
    collections: snapshot.collections ?? [],
    visualCount: snapshot.visuals.length,
    createdAt: snapshot.createdAt,
  };
}

export async function recordObservationV7(input: {
  cwd: string;
  workflowRunId: string;
  registries: RegistrySet;
  tool: string;
  headline: string;
  preset?: string;
  subjectHash?: string;
  evidenceKind?: string;
  resolvedSubjects?: ObservationSnapshotV7["resolvedSubjects"];
  facts?: ObservationSnapshotV7["facts"];
  visuals?: ObservationSnapshotV7["visuals"];
  diagnostics?: ObservationSnapshotV7["diagnostics"];
  provenance: JsonValue;
  payload?: unknown;
  capacity?: number;
}) {
  const capacity = input.capacity ?? 256;
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 4096) throw new Error("Observation index capacity is invalid");
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  return store.mutate(input.registries, async ({ state }) => {
    input.registries.actions.require(input.tool);
    const createdAt = new Date().toISOString();
    const id = `observation-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const payload = jsonValue(input.payload ?? null, "observation.payload");
    const storedPayload: StoredObservationPayloadV1 = { schema: 1, observationId: id, payload };
    const compressedPayload = await gzipAsync(Buffer.from(JSON.stringify(storedPayload)));
    const payloadBytes = compressedPayload.length;
    const payloadDigest = canonicalDigest(storedPayload);
    const collectionDescriptors = descriptors(collectCollections(payload));
    const snapshotRef = `observations/${id}/snapshot.json`;
    const payloadRef = `observations/${id}/payload.json.gz`;
    const body = {
      schema: 1 as const,
      id,
      tool: input.tool,
      phase: state.phase,
      ...(input.preset ? { preset: input.preset } : {}),
      ...(input.subjectHash ? { subjectHash: input.subjectHash } : {}),
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      ...(input.resolvedSubjects?.length ? { resolvedSubjects: input.resolvedSubjects } : {}),
      headline: input.headline,
      facts: input.facts ?? [],
      visuals: input.visuals ?? [],
      diagnostics: input.diagnostics ?? [],
      provenance: input.provenance,
      collections: collectionDescriptors,
      payloadRef,
      payloadDigest,
      payloadBytes,
      createdAt,
    };
    const snapshot: ObservationSnapshotV7 = { ...body, digest: canonicalDigest(body) };
    const current = await store.transactions.readJson<ObservationIndexV1>("indexes/observations.json") ?? { schema: 1 as const, capacity, total: 0, totalPayloadBytes: 0, entries: [] };
    if (current.schema !== 1) throw new Error("Observation index schema mismatch");
    const totalPayloadBytes = (current.totalPayloadBytes ?? current.entries.reduce((sum, item) => sum + (item.payloadBytes ?? 0), 0)) + payloadBytes;
    const quotaBytes = Number(process.env.PI_CAD_OBSERVATION_QUOTA_BYTES ?? 2 * 1024 ** 3);
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0 || totalPayloadBytes > quotaBytes) {
      throw new Error(`observation quota exceeded: ${totalPayloadBytes}/${quotaBytes}; complete payload was not silently discarded`);
    }
    const ref = observationRef(snapshot, snapshotRef);
    const index: ObservationIndexV1 = { schema: 1, capacity, total: current.total + 1, totalPayloadBytes, entries: [ref, ...current.entries].slice(0, capacity) };
    return {
      state: { ...state, contextRefs: { ...(state.contextRefs ?? {}), latestObservation: snapshotRef }, updatedAt: createdAt },
      event: { type: "ObservationRecorded", data: { id, tool: input.tool, phase: state.phase, digest: snapshot.digest, payloadDigest } },
      payloads: { [snapshotRef]: jsonValue(snapshot), [payloadRef]: compressedPayload, "indexes/observations.json": jsonValue(index) },
    };
  });
}

export async function readObservationV7(input: { cwd: string; workflowRunId: string; id: string; registries?: RegistrySet }): Promise<ObservationSnapshotV7> {
  if (!/^observation-[a-z0-9-]+$/i.test(input.id)) throw new Error("Observation ID is invalid");
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  if (input.registries && !await store.load(input.registries)) throw new Error("v7 run does not exist");
  const snapshot = await store.transactions.readJsonBounded<ObservationSnapshotV7>(`observations/${input.id}/snapshot.json`, 4 * 1024 * 1024)
    ?? await store.transactions.readJsonBounded<ObservationSnapshotV7>(`observations/${input.id}.json`, 4 * 1024 * 1024);
  if (!snapshot || snapshot.schema !== 1 || snapshot.id !== input.id) throw new Error("Observation snapshot is missing or malformed");
  const { digest, ...body } = snapshot;
  if (canonicalDigest(body) !== digest) throw new Error("Observation snapshot digest mismatch");
  return snapshot;
}

export async function readObservationPayloadV7(input: { cwd: string; workflowRunId: string; id: string; registries?: RegistrySet }): Promise<JsonValue> {
  const snapshot = await readObservationV7(input);
  if (!snapshot.payloadRef || !snapshot.payloadDigest) throw new Error(`Observation ${input.id} has no full payload (summary-only v7 snapshot)`);
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  const compressed = await store.transactions.readPayloadBounded(snapshot.payloadRef, Math.max(1, snapshot.payloadBytes ?? 256 * 1024 * 1024));
  const payload = compressed ? JSON.parse((await gunzipAsync(compressed)).toString("utf-8")) as StoredObservationPayloadV1 : null;
  if (!payload || payload.schema !== 1 || payload.observationId !== input.id || canonicalDigest(payload) !== snapshot.payloadDigest) throw new Error("Observation payload is missing or its digest does not match");
  return payload.payload;
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

function matches(item: unknown, predicate: NonNullable<ObservationCollectionQueryV7["where"]>[number]): boolean {
  const actual = fieldValue(item, predicate.field);
  if (predicate.op === "eq") return actual === predicate.value;
  if (predicate.op === "ne") return actual !== predicate.value;
  if (predicate.op === "contains") return String(actual ?? "").includes(String(predicate.value ?? ""));
  if (predicate.op === "lt") return (actual as number) < (predicate.value as number);
  if (predicate.op === "lte") return (actual as number) <= (predicate.value as number);
  if (predicate.op === "gt") return (actual as number) > (predicate.value as number);
  return (actual as number) >= (predicate.value as number);
}

function compare(a: unknown, b: unknown, orders: NonNullable<ObservationCollectionQueryV7["orderBy"]>): number {
  for (const order of orders) {
    const av = fieldValue(a, order.field) as string | number | undefined;
    const bv = fieldValue(b, order.field) as string | number | undefined;
    const result = av === bv ? 0 : av === undefined ? -1 : bv === undefined ? 1 : av < bv ? -1 : 1;
    if (result) return order.direction === "desc" ? -result : result;
  }
  return 0;
}

function cursorOffset(cursor: string | undefined, signature: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as { offset?: number; signature?: string };
    if (value.signature !== signature || !Number.isInteger(value.offset) || (value.offset ?? -1) < 0) throw new Error("mismatch");
    return value.offset!;
  } catch {
    throw new Error("invalid or query-mismatched observation cursor");
  }
}

export async function queryObservationCollectionV7(input: {
  cwd: string;
  workflowRunId: string;
  id: string;
  collection: string;
  query?: ObservationCollectionQueryV7;
  registries?: RegistrySet;
}) {
  const snapshot = await readObservationV7(input);
  if (!(snapshot.collections ?? []).some((item) => item.name === input.collection)) throw new Error(`unknown observation collection: ${input.collection}`);
  const payload = await readObservationPayloadV7(input);
  let items = collectCollections(payload).find((item) => item.name === input.collection)?.items ?? [];
  const query = input.query ?? {};
  for (const predicate of query.where ?? []) items = items.filter((item) => matches(item, predicate));
  const orderBy = query.orderBy ?? snapshot.collections!.find((item) => item.name === input.collection)?.defaultOrder ?? [];
  if (orderBy.length) items = [...items].sort((a, b) => compare(a, b, orderBy));
  const signature = createHash("sha256").update(JSON.stringify({ id: input.id, collection: input.collection, where: query.where ?? [], fields: query.fields ?? [], orderBy })).digest("hex");
  const offset = cursorOffset(query.cursor, signature);
  const limit = Math.max(1, Math.min(200, query.limit ?? 50));
  const page = items.slice(offset, offset + limit).map((item) => query.fields?.length ? Object.fromEntries(query.fields.map((field) => [field, fieldValue(item, field)])) : item);
  const nextOffset = offset + page.length;
  return {
    observationId: input.id,
    collection: input.collection,
    totalMatched: items.length,
    items: page,
    nextCursor: nextOffset < items.length ? Buffer.from(JSON.stringify({ offset: nextOffset, signature })).toString("base64url") : undefined,
    remaining: Math.max(0, items.length - nextOffset),
  };
}
