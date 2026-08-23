/**
 * Unified cad_probe tool (refactor Phase 3).
 *
 * One agent-facing observation tool over the PROBE registry:
 *
 *   - preset mode: visual / geometry / surfaces / measure / section /
 *     sections_scan / compare / assembly / interference;
 *   - programmable mode: python (read-only B-Rep computation).
 *
 * The legacy per-preset tools remain as deprecated wrappers until the
 * benchmark gate clears, then they retire.
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
import { Type } from "typebox";

import { readImageContents } from "../../shared/capability.ts";
import { CadProbeParametersSchema, executeCadProbe } from "../../modules/probe/tool.ts";

export default function cadProbeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_probe",
    label: "CAD Probe",
    description:
      "Unified read-only observation interface for design artifacts. preset mode: visual | geometry | surfaces | measure | section | sections_scan | compare | assembly | interference. Programmable mode: preset=python computes anything else over the B-Rep (read-only Python). args shape per preset — visual: {artifact, views?, width?, height?, labels?}; geometry: {artifact, output?}; surfaces: {artifact, labels?, views?}; measure: {artifact, metric, a, b?}; section: {artifact, origin:[x,y,z], normal:[x,y,z], display?, labels?}; sections_scan: {artifact, axis, count|step}; compare: {before, after, metrics?, output?}; assembly: {artifact, output?}; interference: {artifact, output?}. artifact may be omitted when subject=current|baseline is given (resolved from run state). The tool returns facts and images, never engineering judgment.",
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
      "Recover prior observations after context compaction: query the run's observation index by tool/evidence kind/artifact hash and re-attach the recorded engineering visuals (images are referenced from evidence storage, never re-rendered).",
    promptSnippet: "Rehydrate prior observation visuals and facts from the run index",
    promptGuidelines: [
      "Use after compaction when the conversation lost the images/facts you reasoned about.",
      "Narrow with tool/evidenceKind/artifactHash; limit defaults to 5 (newest first).",
      "Recall is read-only memory: it creates no new evidence and never replaces a fresh probe when geometry changed.",
    ],
    parameters: Type.Object(
      {
        tool: Type.Optional(Type.String({ description: "Filter by agent tool name, e.g. cad_probe" })),
        evidenceKind: Type.Optional(Type.String({ description: "Filter by evidence kind, e.g. visual, geometry" })),
        artifactHash: Type.Optional(Type.String({ description: "Filter by artifact hash binding" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { CadProjectStore } = await import("../../shared/store.ts");
      const { queryObservations } = await import("../../core/observation-index.ts");
      const state = await new CadProjectStore(ctx.cwd).load();
      if (!state) {
        return { content: [{ type: "text", text: "cad_recall_observation failed: no active Pi-CAD workflow" }] };
      }
      const records = await queryObservations(ctx.cwd, state.runId, {
        tool: params.tool,
        evidenceKind: params.evidenceKind,
        artifactHash: params.artifactHash,
        limit: params.limit ?? 5,
      });
      if (records.length === 0) {
        return {
          content: [{
            type: "text",
            text: "cad_recall_observation: no matching observations in the run index.",
          }],
        };
      }
      const lines: string[] = [`cad_recall_observation: ${records.length} record(s), newest first.`];
      const imagePaths: string[] = [];
      for (const record of records) {
        lines.push(
          `#${record.id} [${record.phase}] ${record.tool}: ${record.headline}` +
            (record.artifactHash ? ` (artifact ${record.artifactHash.slice(0, 12)})` : ""),
        );
        for (const fact of record.facts.slice(0, 12)) {
          lines.push(`  ${fact.key}: ${fact.value}`);
        }
        imagePaths.push(...record.visuals.slice(0, 4).map((v) => v.path));
      }
      lines.push("Recalled images follow. They are historical observations — re-probe if the artifact changed since.");
      const images = imagePaths.length > 0 ? await readImageContents(imagePaths) : [];
      return {
        content: [{ type: "text", text: lines.join("\n") }, ...images],
        details: { recalled: records.map((r) => r.id) },
      };
    },
  });
}
