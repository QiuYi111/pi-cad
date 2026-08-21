/**
 * Unified cad_probe tool (refactor Phase 3).
 *
 * One agent-facing observation tool over the PROBE registry:
 *
 *   - preset mode: visual / geometry / surfaces / measure / section /
 *     sections-scan / compare / assembly / interference;
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

import { probePython } from "../../shared/capability.ts";
import {
  ensureProbePresets,
  probePreset,
  renderProbeResult,
} from "../../modules/probe/index.ts";

const PRESET_NAMES = {
  visual: "visual",
  geometry: "geometry",
  surfaces: "surfaces",
  measure: "measure",
  section: "section",
  sections_scan: "sections-scan",
  compare: "compare",
  assembly: "assembly",
  interference: "interference",
  python: "python",
} as const;

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
    parameters: Type.Object(
      {
        preset: Type.Enum(PRESET_NAMES),
        args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Preset arguments, e.g. {artifact, metric, a, b} for measure",
          }),
        ),
        subject: Type.Optional(
          Type.Enum({ current: "current", baseline: "baseline" }, {
            description: "python mode: which run-state artifact to probe (default current)",
          }),
        ),
        purpose: Type.Optional(
          Type.String({ description: "python mode: the engineering question this probe answers" }),
        ),
        code: Type.Optional(
          Type.String({ description: "python mode: probe body; must assign `result`" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureProbePresets();

      if (params.preset === "python") {
        return runPythonProbe(ctx.cwd, {
          subject: params.subject ?? "current",
          purpose: params.purpose ?? "",
          code: params.code ?? "",
        });
      }

      const registryName = PRESET_NAMES[params.preset];
      const preset = probePreset(registryName);
      if (!preset) {
        return {
          content: [{ type: "text", text: `cad_probe failed: preset ${registryName} not registered` }],
        };
      }

      const args = { ...(params.args ?? {}) } as Record<string, unknown>;
      if (!args.artifact && (params.subject === "current" || params.subject === "baseline" || params.preset !== "compare")) {
        const resolved = await resolveSubjectArtifact(ctx.cwd, params.subject);
        if (resolved) args.artifact = resolved;
      }
      if (!args.artifact && !args.before) {
        return {
          content: [{
            type: "text",
            text: "cad_probe failed: no artifact in args and no active run artifact to resolve — pass args.artifact (or run inside a Pi-CAD workflow)",
          }],
        };
      }

      const result = await preset.run(args as never, { cwd: ctx.cwd });
      return renderProbeResult(result, `cad_probe/${registryName}`);
    },
  });
}

async function resolveSubjectArtifact(
  cwd: string,
  subject: "current" | "baseline" | undefined,
): Promise<string | null> {
  const { CadProjectStore } = await import("../../shared/store.ts");
  const state = await new CadProjectStore(cwd).load();
  if (!state) return null;
  const which = subject ?? "current";
  return which === "current" ? state.currentArtifactPath : state.baselineArtifactPath;
}

async function runPythonProbe(
  cwd: string,
  params: { subject: "current" | "baseline"; purpose: string; code: string },
) {
  const { CadProjectStore } = await import("../../shared/store.ts");
  const state = await new CadProjectStore(cwd).load();
  if (!state) {
    return { content: [{ type: "text", text: "cad_probe failed: no active Pi-CAD workflow" }] };
  }
  const rel =
    params.subject === "current" ? state.currentArtifactPath : state.baselineArtifactPath;
  if (!rel) {
    return {
      content: [{
        type: "text",
        text: `cad_probe failed: no ${params.subject} artifact bound in run state`,
      }],
    };
  }
  if (!params.code.trim()) {
    return {
      content: [{ type: "text", text: "cad_probe failed: preset=python requires code" }],
    };
  }
  const envelope = await probePython(cwd, rel, params.code);
  const payload = envelope.payload as { result?: unknown };
  return renderProbeResult(
    {
      envelope,
      headline: `cad_probe/python (${params.subject}${params.purpose ? `, ${params.purpose}` : ""}) = ${JSON.stringify(payload.result ?? null, null, 2)}`,
      includeEnvelope: false,
      // No kind: programmable probes are observations, never evidence.
      extraDetails: {
        subjectArtifactHash: envelope.inputHashes.artifact,
        scriptHash: envelope.inputHashes.script,
      },
    },
    "cad_probe/python",
  );
}
