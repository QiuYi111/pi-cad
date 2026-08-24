import { randomUUID } from "node:crypto";

import { canonicalDigest, jsonValue, type JsonValue } from "./canonical.ts";
import type { RegistrySet } from "./registry.ts";
import { HarnessRunStoreV7 } from "./run-store.ts";

export interface ObservationSnapshotV7 {
  schema: 1;
  id: string;
  tool: string;
  phase: string;
  subjectHash?: string;
  headline: string;
  facts: Array<{ key: string; value: JsonValue }>;
  visuals: Array<{ name: string; path: string; sha256: string }>;
  diagnostics: Array<{ level: "info" | "warning" | "error"; message: string }>;
  provenance: JsonValue;
  createdAt: string;
  digest: string;
}

export interface ObservationIndexV1 {
  schema: 1;
  capacity: number;
  total: number;
  entries: Array<{ id: string; path: string; tool: string; phase: string; headline: string; subjectHash?: string; createdAt: string; digest: string }>;
}

export async function recordObservationV7(input: {
  cwd: string;
  workflowRunId: string;
  registries: RegistrySet;
  tool: string;
  headline: string;
  subjectHash?: string;
  facts?: ObservationSnapshotV7["facts"];
  visuals?: ObservationSnapshotV7["visuals"];
  diagnostics?: ObservationSnapshotV7["diagnostics"];
  provenance: JsonValue;
  capacity?: number;
}) {
  const capacity = input.capacity ?? 256;
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 4096) throw new Error("Observation index capacity is invalid");
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  return store.mutate(input.registries, async ({ state }) => {
    input.registries.actions.require(input.tool);
    const createdAt = new Date().toISOString();
    const id = `observation-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const body = {
      schema: 1 as const,
      id,
      tool: input.tool,
      phase: state.phase,
      ...(input.subjectHash ? { subjectHash: input.subjectHash } : {}),
      headline: input.headline,
      facts: input.facts ?? [],
      visuals: input.visuals ?? [],
      diagnostics: input.diagnostics ?? [],
      provenance: input.provenance,
      createdAt,
    };
    const snapshot: ObservationSnapshotV7 = { ...body, digest: canonicalDigest(body) };
    const path = `observations/${id}.json`;
    const current = await store.transactions.readJson<ObservationIndexV1>("indexes/observations.json") ?? { schema: 1 as const, capacity, total: 0, entries: [] };
    if (current.schema !== 1) throw new Error("Observation index schema mismatch");
    const entry = { id, path, tool: input.tool, phase: state.phase, headline: input.headline, ...(input.subjectHash ? { subjectHash: input.subjectHash } : {}), createdAt, digest: snapshot.digest };
    const index: ObservationIndexV1 = { schema: 1, capacity, total: current.total + 1, entries: [entry, ...current.entries].slice(0, capacity) };
    return {
      state: { ...state, contextRefs: { ...(state.contextRefs ?? {}), latestObservation: path }, updatedAt: createdAt },
      event: { type: "ObservationRecorded", data: { id, tool: input.tool, phase: state.phase, digest: snapshot.digest } },
      payloads: { [path]: jsonValue(snapshot), "indexes/observations.json": jsonValue(index) },
    };
  });
}

export async function readObservationV7(input: { cwd: string; workflowRunId: string; id: string; registries?: RegistrySet }): Promise<ObservationSnapshotV7> {
  if (!/^observation-[a-z0-9-]+$/i.test(input.id)) throw new Error("Observation ID is invalid");
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  if (input.registries && !await store.load(input.registries)) throw new Error("v7 run does not exist");
  const snapshot = await store.transactions.readJsonBounded<ObservationSnapshotV7>(`observations/${input.id}.json`, 4 * 1024 * 1024);
  if (!snapshot || snapshot.schema !== 1 || snapshot.id !== input.id) throw new Error("Observation snapshot is missing or malformed");
  const { digest, ...body } = snapshot;
  if (canonicalDigest(body) !== digest) throw new Error("Observation snapshot digest mismatch");
  return snapshot;
}
