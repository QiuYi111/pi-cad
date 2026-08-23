import { Type } from "typebox";

import { probePython } from "../../shared/capability.ts";
import { CadProjectStore } from "../../shared/store.ts";
import { ensureProbePresets, probePreset, renderProbeResult } from "./index.ts";

export const CAD_PROBE_PRESET_NAMES = {
  visual: "visual",
  geometry: "geometry",
  surfaces: "surfaces",
  measure: "measure",
  section: "section",
  sections_scan: "sections_scan",
  compare: "compare",
  assembly: "assembly",
  interference: "interference",
  python: "python",
} as const;

export const CadProbeParametersSchema = Type.Object(
  {
    preset: Type.Enum(CAD_PROBE_PRESET_NAMES),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    subject: Type.Optional(Type.Enum({ current: "current", baseline: "baseline" })),
    purpose: Type.Optional(Type.String()),
    code: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export interface CadProbeParams {
  preset: (typeof CAD_PROBE_PRESET_NAMES)[keyof typeof CAD_PROBE_PRESET_NAMES];
  args?: Record<string, unknown>;
  subject?: "current" | "baseline";
  purpose?: string;
  code?: string;
}

export async function executeCadProbe(cwd: string, params: CadProbeParams) {
  ensureProbePresets();
  if (params.preset === "python") {
    return runPythonProbe(cwd, {
      subject: params.subject ?? "current",
      purpose: params.purpose ?? "",
      code: params.code ?? "",
    });
  }
  const registryName = params.preset;
  const preset = probePreset(registryName);
  if (!preset) {
    return { content: [{ type: "text" as const, text: `cad_probe failed: preset ${registryName} not registered` }] };
  }
  const args = { ...(params.args ?? {}) } as Record<string, unknown>;
  if (!args.artifact && (params.subject || params.preset !== "compare")) {
    const resolved = await resolveSubjectArtifact(cwd, params.subject);
    if (resolved) args.artifact = resolved;
  }
  if (!args.artifact && !args.before) {
    return {
      content: [{
        type: "text" as const,
        text: "cad_probe failed: no artifact in args and no active run artifact to resolve — pass args.artifact (or run inside a Pi-CAD workflow)",
      }],
    };
  }
  const result = await preset.run(args as never, { cwd });
  return renderProbeResult(result, `cad_probe/${registryName}`);
}

async function resolveSubjectArtifact(
  cwd: string,
  subject: "current" | "baseline" | undefined,
): Promise<string | null> {
  const state = await new CadProjectStore(cwd).load();
  if (!state) return null;
  return (subject ?? "current") === "current" ? state.currentArtifactPath ?? null : state.baselineArtifactPath ?? null;
}

async function runPythonProbe(
  cwd: string,
  params: { subject: "current" | "baseline"; purpose: string; code: string },
) {
  const state = await new CadProjectStore(cwd).load();
  if (!state) return { content: [{ type: "text" as const, text: "cad_probe failed: no active Pi-CAD workflow" }] };
  const rel = params.subject === "current" ? state.currentArtifactPath : state.baselineArtifactPath;
  if (!rel) {
    return { content: [{ type: "text" as const, text: `cad_probe failed: no ${params.subject} artifact bound in run state` }] };
  }
  if (!params.code.trim()) {
    return { content: [{ type: "text" as const, text: "cad_probe failed: preset=python requires code" }] };
  }
  const envelope = await probePython(cwd, rel, params.code);
  const payload = envelope.payload as { result?: unknown };
  return renderProbeResult(
    {
      envelope,
      headline: `cad_probe/python (${params.subject}${params.purpose ? `, ${params.purpose}` : ""}) = ${JSON.stringify(payload.result ?? null, null, 2)}`,
      includeEnvelope: false,
      extraDetails: {
        subjectArtifactHash: envelope.inputHashes.artifact,
        scriptHash: envelope.inputHashes.script,
      },
    },
    "cad_probe/python",
  );
}
