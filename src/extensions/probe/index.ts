/**
 * Unified cad_probe tool (refactor Phase 3).
 *
 * One agent-facing observation tool over the PROBE registry:
 *
 *   - preset mode: visual / geometry / surfaces / measure / section /
 *     sections_scan / compare / assembly / interference;
 *   - programmable mode: python (arbitrary code on a disposable STEP copy).
 *
 * Design invariants:
 *   - the canonical design is unchanged by presets and disposable experiments;
 *   - `subject` resolution (current/baseline) reads run state, never a
 *     path supplied by the agent (python mode);
 *   - observations are hash-bound; only presets with an evidence kind
 *     can close obligations, and that binding happens in the control
 *     plane, not here.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { MECHANICAL_ACTION_PARAMETERS } from "../../domains/mechanical/action-schemas.ts";

import { readImageContents } from "../../shared/image-content.ts";
import { executeCadProbe } from "../../modules/probe/tool.ts";
import { mechanicalRegistries } from "../../domains/mechanical/registries.ts";
import { resolveActiveRun } from "../../harness/run-scope.ts";
import { HarnessRunStoreV7 } from "../../harness/run-store.ts";
import { readObservationV7, type ObservationIndexV1, type ObservationSnapshotV7 } from "../../harness/observations.ts";

type Predicate = { field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains"; value?: unknown };
type Order = { field: string; direction: "asc" | "desc" };
interface RecallQuery { where?: Predicate[]; fields?: string[]; orderBy?: Order[]; cursor?: string; limit?: number }

const COLLECTIONS = ["facts", "diagnostics", "visuals"] as const;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

// v7 observations carry their detail as three flat record lists. Collection
// paging keeps the v6 contract (where / fields / orderBy / cursor / limit) and
// the cursor stays bound to the query it was issued for.
function collectionItems(snapshot: ObservationSnapshotV7, name: string): unknown[] | undefined {
  if (name === "facts") return snapshot.facts;
  if (name === "diagnostics") return snapshot.diagnostics;
  if (name === "visuals") return snapshot.visuals;
  return undefined;
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

function matchesPredicate(item: unknown, predicate: Predicate): boolean {
  const actual = fieldValue(item, predicate.field);
  if (predicate.op === "eq") return actual === predicate.value;
  if (predicate.op === "ne") return actual !== predicate.value;
  if (predicate.op === "contains") return String(actual ?? "").includes(String(predicate.value ?? ""));
  if (predicate.op === "lt") return (actual as number) < (predicate.value as number);
  if (predicate.op === "lte") return (actual as number) <= (predicate.value as number);
  if (predicate.op === "gt") return (actual as number) > (predicate.value as number);
  return (actual as number) >= (predicate.value as number);
}

function compareItems(a: unknown, b: unknown, orderBy: Order[]): number {
  for (const order of orderBy) {
    const av = fieldValue(a, order.field) as string | number | undefined;
    const bv = fieldValue(b, order.field) as string | number | undefined;
    const comparison = av === bv ? 0 : av === undefined ? -1 : bv === undefined ? 1 : av < bv ? -1 : 1;
    if (comparison) return order.direction === "desc" ? -comparison : comparison;
  }
  return 0;
}

function projectFields(item: unknown, fields?: string[]): unknown {
  if (!fields?.length || !item || typeof item !== "object") return item;
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

function queryCollection(snapshot: ObservationSnapshotV7, collection: string, query: RecallQuery) {
  let items = collectionItems(snapshot, collection) ?? [];
  for (const predicate of query.where ?? []) items = items.filter((item) => matchesPredicate(item, predicate));
  const orderBy = query.orderBy ?? [];
  if (orderBy.length) items = [...items].sort((a, b) => compareItems(a, b, orderBy));
  const signature = createHash("sha256").update(JSON.stringify({ observationId: snapshot.id, collection, where: query.where ?? [], fields: query.fields ?? [], orderBy })).digest("hex");
  const offset = decodeCursor(query.cursor, signature);
  const limit = Math.max(1, Math.min(MAX_PAGE, query.limit ?? DEFAULT_PAGE));
  const page = items.slice(offset, offset + limit).map((item) => projectFields(item, query.fields));
  const nextOffset = offset + page.length;
  return {
    observationId: snapshot.id,
    collection,
    totalMatched: items.length,
    items: page,
    nextCursor: nextOffset < items.length ? Buffer.from(JSON.stringify({ offset: nextOffset, signature })).toString("base64url") : undefined,
    remaining: Math.max(0, items.length - nextOffset),
  };
}

function factText(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

export default function cadProbeExtension(pi: ExtensionAPI) {
  registerMechanicalActionTool(pi, {
    name: "cad_probe",
    label: "CAD Probe",
    description:
      "CAD observation interface. Presets inspect artifacts; python runs arbitrary analysis on a disposable STEP copy. The original candidate is unchanged. Results echo the resolved subject and persist pageable detail.",
    promptSnippet: "Observe design artifacts: typed presets or programmable Python probes",
    promptGuidelines: [
      "Pick the preset that answers the question; use preset=python for custom geometry operations or analysis.",
      "Selectors (#pN/#cN/#fN, surface IDs) come from geometry/surfaces presets and are hash-scoped — they die with the next candidate.",
      "preset=python needs a subject, purpose, and exactly one of code or a project-local script path. JSON args are decoded as Python values in `params`; scope preloads shape, bd, np, math, statistics.",
      "Observations bind evidence only through the control plane (commit/review); probing never mutates the canonical design.",
      "Python runs against a disposable STEP copy with scratch files; assigning a JSON-serializable `result` is required. Change the official candidate through model.build, not by writing to scratch.",
    ],
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_probe,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeCadProbe(ctx.cwd, params, mechanicalRegistries, signal);
    },
  });

  // Phase 8: post-compaction rehydration over the per-run observation
  // index. The index references evidence images by path; recall re-
  // attaches them without re-running any backend.
  registerMechanicalActionTool(pi, {
    name: "cad_recall_observation",
    label: "CAD Recall Observation",
    description:
      "Discover immutable observations or page their complete detail collections. Without observationId, query summaries. With observationId, inspect its catalog; add collection/filter/order/cursor to read any page without re-running the probe.",
    promptSnippet: "Discover observations and page complete immutable detail collections",
    promptGuidelines: [
      "Start without observationId to discover summaries, then pass an observationId to inspect its collection catalog.",
      "Collection pages default to 50 and max at 200. Continue with nextCursor until it is absent; page size is not a semantic result limit.",
      "Filters and ordering are cursor-bound. Changing either invalidates the old cursor.",
      "Recall is read-only memory: it creates no new evidence and never replaces a fresh probe when geometry changed.",
    ],
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_recall_observation,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await resolveActiveRun(ctx.cwd, mechanicalRegistries);
      if (!loaded) {
        return { content: [{ type: "text", text: "cad_recall_observation failed: no active Pi-CAD workflow" }], isError: true };
      }
      const runId = loaded.state.runId;
      if (params.collection && !params.observationId) {
        return { content: [{ type: "text", text: "cad_recall_observation failed: collection requires observationId" }], isError: true };
      }
      if (params.evidenceKind) {
        return { content: [{ type: "text", text: "cad_recall_observation failed: evidenceKind is not recorded on v7 observations; filter by tool or artifactHash" }], isError: true };
      }
      if (params.observationId) {
        const snapshot = await readObservationV7({ cwd: ctx.cwd, workflowRunId: runId, id: params.observationId, registries: mechanicalRegistries }).catch(() => null);
        if (!snapshot) {
          return { content: [{ type: "text", text: `cad_recall_observation failed: unknown observationId ${params.observationId}` }], isError: true };
        }
        if (params.collection) {
          if (!(COLLECTIONS as readonly string[]).includes(params.collection)) {
            return { content: [{ type: "text", text: `cad_recall_observation failed: unknown observation collection: ${params.collection}` }], isError: true };
          }
          try {
            const page = queryCollection(snapshot, params.collection, params);
            return {
              content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
              details: { observationId: snapshot.id, collection: params.collection, totalMatched: page.totalMatched, nextCursor: page.nextCursor },
            };
          } catch (error) {
            return { content: [{ type: "text", text: `cad_recall_observation failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
          }
        }
        const counts = Object.fromEntries(COLLECTIONS.map((name) => [name, collectionItems(snapshot, name)?.length ?? 0]));
        const lines = [
          `cad_recall_observation: ${snapshot.id}`,
          `${snapshot.tool}/${snapshot.phase}: ${snapshot.headline}`,
          ...(snapshot.subjectHash ? [`subjectHash: ${snapshot.subjectHash}`] : []),
          ...snapshot.facts.slice(0, 16).map((fact) => `${fact.key}: ${factText(fact.value)}`),
          "Collections:",
          ...COLLECTIONS.map((name) => `- ${name}: ${counts[name]} item(s)`),
          "Use observationId + collection to page complete detail.",
        ];
        let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        if (snapshot.visuals.length) {
          try {
            images = await readImageContents(snapshot.visuals.slice(0, 8).map((item) => resolve(ctx.cwd, item.path)));
          } catch {
            lines.push("visuals: image files are unavailable");
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }, ...images],
          details: { observationId: snapshot.id, collections: counts },
        };
      }
      const index = await new HarnessRunStoreV7(ctx.cwd, runId).transactions.readJson<ObservationIndexV1>("indexes/observations.json");
      const records = (index?.entries ?? [])
        .filter((entry) => (!params.tool || entry.tool === params.tool) && (!params.artifactHash || entry.subjectHash === params.artifactHash))
        .slice(0, params.limit ?? 20);
      if (records.length === 0) {
        return {
          content: [{
            type: "text",
            text: "cad_recall_observation: no matching observations in the run index.",
          }],
        };
      }
      const lines: string[] = [`cad_recall_observation: ${records.length} summary record(s), newest first.`];
      for (const record of records) {
        lines.push(
          `${record.id} [${record.phase}] ${record.tool}: ${record.headline}` +
            (record.subjectHash ? ` (artifact ${record.subjectHash.slice(0, 12)})` : ""),
        );
        lines.push(`  createdAt=${record.createdAt} digest=${record.digest.slice(0, 12)}`);
      }
      lines.push("Pass observationId to recover facts, visuals, provenance, and its collection catalog.");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { recalled: records.map((r) => r.id) },
      };
    },
  });
}
