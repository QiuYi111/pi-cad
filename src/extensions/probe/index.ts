/**
 * Unified cad_probe tool (refactor Phase 3).
 *
 * One agent-facing observation tool over the PROBE registry:
 *
 *   - preset mode: visual / geometry / surfaces / measure / section /
 *     sections_scan / compare / assembly / interference;
 *   - programmable mode: python (read-only B-Rep computation).
 *
 * Design invariants:
 *   - the canonical design is immutable from here (read-only presets);
 *   - `subject` resolution (current/baseline) reads run state, never a
 *     path supplied by the agent (python mode);
 *   - observations are hash-bound; only presets with an evidence kind
 *     can close obligations, and that binding happens in the control
 *     plane, not here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readImageContents } from "../../shared/capability.ts";
import { CadProbeParametersSchema, CadRecallObservationParametersSchema, executeCadProbe } from "../../modules/probe/tool.ts";

export default function cadProbeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_probe",
    label: "CAD Probe",
    description:
      "Unified read-only observation interface. Its discriminated TypeBox schema is authoritative: every preset accepts only applicable fields; ordinary presets require exactly one subject form, compare requires explicit before/after, and programmable mode accepts only a bound subject, purpose, and code. Results echo the resolved subject and persist complete immutable pageable detail.",
    promptSnippet: "Observe design artifacts: typed presets or programmable Python probes",
    promptGuidelines: [
      "One tool for all observation: pick the preset that answers the question; use preset=python only when no typed preset can express it.",
      "Selectors (#pN/#cN/#fN, surface IDs) come from geometry/surfaces presets and are hash-scoped — they die with the next candidate.",
      "preset=python needs subject=current|baseline, purpose, and code assigning a JSON-serializable `result`; scope preloads shape, bd, np, math, statistics.",
      "Observations bind evidence only through the control plane (commit/review); probing never mutates the canonical design.",
    ],
    parameters: CadProbeParametersSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeCadProbe(ctx.cwd, params);
    },
  });

  // Phase 8: post-compaction rehydration over the per-run observation
  // index. The index references evidence images by path; recall re-
  // attaches them without re-running any backend.
  pi.registerTool({
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
    parameters: CadRecallObservationParametersSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { CadProjectStore } = await import("../../shared/store.ts");
      const { queryObservationCollection, queryObservations, readObservationSnapshot } = await import("../../core/observation-index.ts");
      const state = await new CadProjectStore(ctx.cwd).load();
      if (!state) {
        return { content: [{ type: "text", text: "cad_recall_observation failed: no active Pi-CAD workflow" }] };
      }
      if (params.collection && !params.observationId) {
        return { content: [{ type: "text", text: "cad_recall_observation failed: collection requires observationId" }] };
      }
      if (params.observationId) {
        const snapshot = await readObservationSnapshot(ctx.cwd, state.runId, params.observationId);
        if (!snapshot) {
          const legacy = (await queryObservations(ctx.cwd, state.runId, { limit: 200 })).find((item) => item.observationId === params.observationId);
          return {
            content: [{ type: "text", text: legacy
              ? `cad_recall_observation: ${params.observationId} is a legacy summary; detailUnavailable=legacy`
              : `cad_recall_observation failed: unknown observationId ${params.observationId}` }],
          };
        }
        if (params.collection) {
          try {
            const page = await queryObservationCollection(ctx.cwd, state.runId, params.observationId, params.collection, {
              where: params.where,
              fields: params.fields,
              orderBy: params.orderBy,
              cursor: params.cursor,
              limit: params.limit,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
              details: { observationId: params.observationId, collection: params.collection, totalMatched: page.totalMatched, nextCursor: page.nextCursor },
            };
          } catch (error) {
            return { content: [{ type: "text", text: `cad_recall_observation failed: ${error instanceof Error ? error.message : String(error)}` }] };
          }
        }
        const lines = [
          `cad_recall_observation: ${snapshot.observationId}`,
          `${snapshot.tool}${snapshot.preset ? `/${snapshot.preset}` : ""}: ${snapshot.headline}`,
          ...(snapshot.resolvedSubjects ?? []).map((item) => `resolvedSubject ${item.source}: ${item.path}${item.sha256 ? ` sha256=${item.sha256}` : ""}`),
          ...((snapshot.facts ?? []).slice(0, 16).map((fact) => `${fact.key}: ${fact.value}`)),
          "Collections:",
          ...(snapshot.collections.length
            ? snapshot.collections.map((item) => `- ${item.name}: ${item.count} item(s); fields=${item.fields.join(",") || "value"}`)
            : ["- none"]),
          "Use observationId + collection to page complete detail.",
        ];
        const images = snapshot.visuals?.length ? await readImageContents(snapshot.visuals.slice(0, 8).map((item) => item.path)) : [];
        return {
          content: [{ type: "text", text: lines.join("\n") }, ...images],
          details: { observationId: snapshot.observationId, collections: snapshot.collections },
        };
      }
      const records = await queryObservations(ctx.cwd, state.runId, {
        tool: params.tool,
        evidenceKind: params.evidenceKind,
        artifactHash: params.artifactHash,
        limit: params.limit ?? 20,
      });
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
          `${record.observationId ?? `legacy-${record.id}`} [${record.phase}] ${record.tool}: ${record.headline}` +
            (record.artifactHash ? ` (artifact ${record.artifactHash.slice(0, 12)})` : ""),
        );
        lines.push(`  collections=${record.collections?.map((item) => `${item.name}:${item.count}`).join(",") || "none"}; detailUnavailable=${record.detailAvailable === false || !record.observationId ? "legacy" : "false"}`);
      }
      lines.push("Pass observationId to recover facts, visuals, provenance, and its collection catalog.");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { recalled: records.map((r) => r.observationId ?? `legacy-${r.id}`) },
      };
    },
  });
}
