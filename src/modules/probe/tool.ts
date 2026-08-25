import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { probePython } from "../../shared/capability.ts";
import { CadProjectStore } from "../../shared/store.ts";
import { bundleFromEnvelope, type ObservationBundle } from "../../observations/bundle.ts";
import { recordObservation } from "../../core/observation-index.ts";
import { ensureProbePresets, probePreset, renderProbeResult } from "./index.ts";
import { selectKernelEngine } from "../../harness/engine-router.ts";
import { HarnessProjectStoreV7 } from "../../harness/run-store.ts";
import { mechanicalRegistries } from "../../domains/mechanical/registries.ts";
import { recordObservationV7 } from "../../harness/observations.ts";
import type { AgentArtifactSubject } from "../../agent-api/protocol.ts";

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

const SubjectSchema = Type.Enum({ current: "current", baseline: "baseline" });
const target = (fields: Record<string, any> = {}) => Type.Object(
  { artifact: Type.Optional(Type.String({ minLength: 1 })), ...fields },
  { additionalProperties: false },
);
const typed = (
  preset: keyof typeof CAD_PROBE_PRESET_NAMES,
  args: any,
  allowSubject = true,
  argsRequired = false,
) => {
  const base = { preset: Type.Literal(preset), purpose: Type.Optional(Type.String()) };
  if (!allowSubject) return Type.Object({ ...base, args }, { additionalProperties: false });
  const properties = { ...(args.properties ?? {}) } as Record<string, any>;
  delete properties.artifact;
  const subjectArgs = Type.Object(properties, { additionalProperties: false });
  const explicitArgs = Type.Object({ artifact: Type.String({ minLength: 1 }), ...properties }, { additionalProperties: false });
  return Type.Union([
    Type.Object({ ...base, subject: SubjectSchema, args: argsRequired ? subjectArgs : Type.Optional(subjectArgs) }, { additionalProperties: false }),
    Type.Object({ ...base, args: explicitArgs }, { additionalProperties: false }),
  ]);
};

export const CadProbeParametersSchema = Type.Union([
  typed("visual", target({ views: Type.Optional(Type.Array(Type.String())), width: Type.Optional(Type.Integer({ minimum: 64 })), height: Type.Optional(Type.Integer({ minimum: 64 })), labels: Type.Optional(Type.Boolean()), display: Type.Optional(Type.Literal("solid")) })),
  typed("geometry", target({ output: Type.Optional(Type.String()) })),
  typed("surfaces", target({ labels: Type.Optional(Type.Boolean()), views: Type.Optional(Type.Array(Type.String())) })),
  typed("measure", target({ metric: Type.String({ minLength: 1 }), a: Type.String({ minLength: 1 }), b: Type.Optional(Type.String()) }), true, true),
  typed("section", target({ origin: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]), normal: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]), display: Type.Optional(Type.Enum({ solid: "solid", hidden_edges: "hidden_edges", solid_with_hidden: "solid_with_hidden" })), width: Type.Optional(Type.Integer({ minimum: 64 })), height: Type.Optional(Type.Integer({ minimum: 64 })), labels: Type.Optional(Type.Boolean()) }), true, true),
  typed("sections_scan", target({ axis: Type.Enum({ x: "x", y: "y", z: "z" }), count: Type.Optional(Type.Integer({ minimum: 2 })), step: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }), true, true),
  typed("assembly", target({ output: Type.Optional(Type.String()) })),
  typed("interference", target({ output: Type.Optional(Type.String()) })),
  typed("compare", Type.Object({ before: Type.String({ minLength: 1 }), after: Type.String({ minLength: 1 }), metrics: Type.Optional(Type.Array(Type.String())), transformBefore: Type.Optional(Type.Array(Type.Array(Type.Number()))), transformAfter: Type.Optional(Type.Array(Type.Array(Type.Number()))), output: Type.Optional(Type.String()) }, { additionalProperties: false }), false, true),
  Type.Object({ preset: Type.Literal("python"), subject: SubjectSchema, purpose: Type.String({ minLength: 1 }), code: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

export const CadRecallObservationParametersSchema = Type.Object(
  {
    observationId: Type.Optional(Type.String({ minLength: 1, description: "Immutable observation ID, e.g. obs-000001" })),
    collection: Type.Optional(Type.String({ minLength: 1, description: "Collection name from the observation catalog" })),
    where: Type.Optional(Type.Array(Type.Object({
      field: Type.String({ minLength: 1 }),
      op: Type.Enum({ eq: "eq", ne: "ne", lt: "lt", lte: "lte", gt: "gt", gte: "gte", contains: "contains" }),
      value: Type.Unknown(),
    }, { additionalProperties: false }))),
    fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    orderBy: Type.Optional(Type.Array(Type.Object({
      field: Type.String({ minLength: 1 }),
      direction: Type.Enum({ asc: "asc", desc: "desc" }),
    }, { additionalProperties: false }))),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    tool: Type.Optional(Type.String({ description: "Filter by agent tool name, e.g. cad_probe" })),
    evidenceKind: Type.Optional(Type.String({ description: "Filter by evidence kind, e.g. visual, geometry" })),
    artifactHash: Type.Optional(Type.String({ description: "Filter by artifact hash binding" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export interface CadProbeParams {
  preset: (typeof CAD_PROBE_PRESET_NAMES)[keyof typeof CAD_PROBE_PRESET_NAMES];
  args?: Record<string, unknown>;
  subject?: "current" | "baseline" | AgentArtifactSubject;
  purpose?: string;
  code?: string;
}

export async function executeCadProbe(cwd: string, params: CadProbeParams) {
  ensureProbePresets();
  if (params.preset === "python") {
    const rendered = await runPythonProbe(cwd, {
      subject: params.subject ?? "current",
      purpose: params.purpose ?? "",
      code: params.code ?? "",
    });
    return persistProbeObservation(cwd, params.preset, rendered);
  }
  const registryName = params.preset;
  const preset = probePreset(registryName);
  if (!preset) {
    return { content: [{ type: "text" as const, text: `cad_probe failed: preset ${registryName} not registered` }] };
  }
  const args = { ...(params.args ?? {}) } as Record<string, unknown>;
  if (params.subject && args.artifact) {
    return { content: [{ type: "text" as const, text: "cad_probe failed: subject and args.artifact are mutually exclusive; choose one exact target" }] };
  }
  if (!params.subject && !args.artifact && params.preset !== "compare") {
    return { content: [{ type: "text" as const, text: "cad_probe failed: provide exactly one target via subject=current|baseline or args.artifact" }] };
  }
  const direct = params.subject && typeof params.subject !== "string" ? await resolveArtifactSubject(cwd, params.subject) : null;
  const targetSource = typeof args.artifact === "string" ? "explicit" : direct ? "artifact-ref" : params.subject ?? "current";
  if (!args.artifact && params.subject) {
    const resolved = direct?.path ?? await resolveSubjectArtifact(cwd, params.subject as "current" | "baseline");
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
  applyPresetDefaults(params.preset, args);
  const result = await preset.run(args as never, { cwd });
  if (direct?.expectedHash && result.envelope.inputHashes.artifact !== direct.expectedHash) {
    return {
      content: [{ type: "text" as const, text: `cad_probe failed: ArtifactRef changed while probing ${params.subject && typeof params.subject !== "string" ? params.subject.path : args.artifact}` }],
      details: { presetFailed: true, envelope: result.envelope },
    };
  }
  const resolvedSubjects = params.preset === "compare"
    ? [
        { source: "before", path: String(args.before), sha256: result.envelope.inputHashes.before },
        { source: "after", path: String(args.after), sha256: result.envelope.inputHashes.after },
      ]
    : [{ source: targetSource, path: String(args.artifact), sha256: result.envelope.inputHashes.artifact }];
  result.extraDetails = { ...(result.extraDetails ?? {}), resolvedSubjects, ...(resolvedSubjects.length === 1 ? { resolvedSubject: resolvedSubjects[0] } : {}) };
  const rendered = await renderProbeResult(result, `cad_probe/${registryName}`);
  return persistProbeObservation(cwd, params.preset, rendered);
}

function applyPresetDefaults(preset: CadProbeParams["preset"], args: Record<string, unknown>): void {
  if (preset === "visual") Object.assign(args, { views: args.views ?? ["iso"], width: args.width ?? 900, height: args.height ?? 700, labels: args.labels ?? false, display: args.display ?? "solid" });
  if (preset === "surfaces") Object.assign(args, { labels: args.labels ?? false });
  if (preset === "section") Object.assign(args, { display: args.display ?? "solid", width: args.width ?? 900, height: args.height ?? 700, labels: args.labels ?? false });
}

async function resolveSubjectArtifact(
  cwd: string,
  subject: "current" | "baseline" | undefined,
): Promise<string | null> {
  if (await selectKernelEngine(cwd) === "v7") {
    const project = new HarnessProjectStoreV7(cwd);
    const loaded = await project.currentRun(mechanicalRegistries);
    if (!loaded) return null;
    if ((subject ?? "current") === "baseline") {
      const { state } = await project.load();
      return Object.values(state.head.artifacts).find((item) => /authoritative|design|candidate/i.test(item.role))?.path ?? Object.values(state.head.artifacts)[0]?.path ?? null;
    }
    return Object.values(loaded.state.artifacts).find((item) => /authoritative|design|candidate/i.test(item.role))?.path ?? Object.values(loaded.state.artifacts)[0]?.path ?? null;
  }
  const state = await new CadProjectStore(cwd).load();
  if (!state) return null;
  return (subject ?? "current") === "current" ? state.currentArtifactPath ?? null : state.baselineArtifactPath ?? null;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function resolveArtifactSubject(cwd: string, subject: AgentArtifactSubject): Promise<{ path: string; expectedHash?: string }> {
  if (subject.kind !== "artifact" || typeof subject.path !== "string" || !subject.path.trim()) {
    throw new Error("cad.probe ArtifactRef subject requires a non-empty path");
  }
  if (/^[a-zA-Z]:[\\/]/.test(subject.path)) throw new Error("cad.probe ArtifactRef uses Linux/WSL paths; Windows paths are rejected");
  if (subject.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(subject.sha256)) {
    throw new Error("cad.probe ArtifactRef sha256 must be 64 lowercase hexadecimal characters");
  }
  const root = await realpath(cwd);
  const requested = isAbsolute(subject.path) ? subject.path : resolve(root, subject.path);
  const path = await realpath(requested);
  if (!inside(root, path)) throw new Error(`cad.probe ArtifactRef escapes the project root: ${subject.path}`);
  if (subject.sha256) {
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== subject.sha256) throw new Error(`cad.probe ArtifactRef hash mismatch for ${subject.path}`);
  }
  return { path: relative(root, path).replaceAll("\\", "/"), ...(subject.sha256 ? { expectedHash: subject.sha256 } : {}) };
}

async function runPythonProbe(
  cwd: string,
  params: { subject: "current" | "baseline" | AgentArtifactSubject; purpose: string; code: string },
) {
  const direct = typeof params.subject === "string" ? null : await resolveArtifactSubject(cwd, params.subject);
  const rel = direct?.path ?? await resolveSubjectArtifact(cwd, params.subject as "current" | "baseline");
  const label = typeof params.subject === "string" ? params.subject : params.subject.path;
  if (!rel) {
    return { content: [{ type: "text" as const, text: `cad_probe failed: no ${label} artifact bound in run state` }] };
  }
  if (!params.code.trim()) {
    return { content: [{ type: "text" as const, text: "cad_probe failed: preset=python requires code" }] };
  }
  const envelope = await probePython(cwd, rel, params.code);
  if (direct?.expectedHash && envelope.inputHashes.artifact !== direct.expectedHash) {
    return {
      content: [{ type: "text" as const, text: `cad_probe failed: ArtifactRef changed while probing ${params.subject.path}` }],
      details: { presetFailed: true, envelope },
    };
  }
  const payload = envelope.payload as { result?: unknown };
  return renderProbeResult(
    {
      envelope,
      headline: `cad_probe/python completed for ${label}${params.purpose ? `: ${params.purpose}` : ""}`,
      facts: summarizePythonResult(payload.result),
      includeEnvelope: false,
      extraDetails: {
        subjectArtifactHash: envelope.inputHashes.artifact,
        scriptHash: envelope.inputHashes.script,
        resolvedSubjects: [{ source: typeof params.subject === "string" ? params.subject : "artifact-ref", path: rel, sha256: envelope.inputHashes.artifact }],
      },
    },
    "cad_probe/python",
  );
}

function summarizePythonResult(value: unknown): Array<{ key: string; value: string }> {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [{ key: "result", value: JSON.stringify(value) }];
  }
  if (Array.isArray(value)) {
    return [{ key: "result", value: `array(${value.length}); full values available in the result collection` }];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const facts = entries
      .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 16)
      .map(([key, item]) => ({ key, value: JSON.stringify(item) }));
    const collectionCount = entries.filter(([, item]) => Array.isArray(item)).length;
    if (collectionCount) facts.push({ key: "collections", value: `${collectionCount} array field(s); page them with cad_recall_observation` });
    return facts.length ? facts : [{ key: "result", value: `object(${entries.length} fields); inspect its collections by observationId` }];
  }
  return [{ key: "result", value: String(value) }];
}

async function persistProbeObservation(
  cwd: string,
  preset: string,
  rendered: Awaited<ReturnType<typeof renderProbeResult>>,
) {
  if (!("details" in rendered) || !rendered.details) return rendered;
  if (await selectKernelEngine(cwd) === "v7") {
    const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    if (!loaded) return rendered;
    const envelope = rendered.details.envelope as any;
    const observation = rendered.details.observation as ObservationBundle | undefined;
    const bundle = observation ?? bundleFromEnvelope(envelope, { headline: envelope?.ok ? `cad_probe/${preset}` : `cad_probe/${preset} failed` });
    try {
      const artifacts = new Map((bundle.artifacts ?? []).map((item) => [item.path, item.sha256]));
      const recorded = await recordObservationV7({
        cwd,
        workflowRunId: loaded.state.runId,
        registries: mechanicalRegistries,
        tool: "cad_probe",
        headline: bundle.headline,
        ...(typeof rendered.details.artifactHash === "string" ? { subjectHash: rendered.details.artifactHash } : {}),
        facts: bundle.facts.map((item) => ({ key: item.key, value: item.value })),
        visuals: bundle.visuals.flatMap((item) => artifacts.get(item.path) ? [{ name: item.name, path: item.path, sha256: artifacts.get(item.path)! }] : []),
        diagnostics: bundle.diagnostics,
        provenance: bundle.provenance as never,
      });
      const path = recorded.state.contextRefs!.latestObservation!;
      const id = path.split("/").at(-1)!.replace(/\.json$/, "");
      const text = rendered.content.find((item) => item.type === "text");
      if (text) text.text = `${text.text ?? ""}\nobservationId=${id} immutablePath=${path}`;
      rendered.details.observationId = id;
      rendered.details.observationPath = path;
      rendered.details.observationStored = true;
      return rendered;
    } catch (error) {
      return { content: [{ type: "text" as const, text: `cad_probe failed to persist v7 immutable observation: ${error instanceof Error ? error.message : String(error)}` }], details: { presetFailed: true, observationStorageFailed: true } };
    }
  }
  const state = await new CadProjectStore(cwd).load();
  if (!state) return rendered;
  const envelope = rendered.details.envelope as any;
  const observation = rendered.details.observation as ObservationBundle | undefined;
  const bundle = observation ?? bundleFromEnvelope(envelope, {
    headline: envelope?.ok ? `cad_probe/${preset}` : `cad_probe/${preset} failed`,
  });
  try {
    const record = await recordObservation({
      cwd,
      runId: state.runId,
      phase: state.phase,
      tool: "cad_probe",
      bundle,
      ...(typeof rendered.details.artifactHash === "string" ? { artifactHash: rendered.details.artifactHash } : {}),
      ...(typeof rendered.details.kind === "string" ? { evidenceKind: rendered.details.kind } : {}),
      preset,
      resolvedSubjects: Array.isArray(rendered.details.resolvedSubjects) ? rendered.details.resolvedSubjects as any : undefined,
      rawPayload: envelope?.payload,
    });
    const text = rendered.content.find((item) => item.type === "text");
    if (text) {
      const resolved = Array.isArray(rendered.details.resolvedSubjects)
        ? (rendered.details.resolvedSubjects as Array<{ source: string; path: string; sha256?: string }>).map((item) => `resolvedSubject.source=${item.source} path=${item.path} sha256=${item.sha256 ?? "unavailable"}`)
        : [];
      text.text = `${text.text ?? ""}\n${resolved.join("\n")}${resolved.length ? "\n" : ""}observationId=${record.observationId} collections=${record.collections?.map((item) => `${item.name}:${item.count}`).join(",") || "none"}`;
    }
    rendered.details.observationId = record.observationId;
    rendered.details.observationStored = true;
    return rendered;
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `cad_probe failed to persist its complete immutable observation: ${error instanceof Error ? error.message : String(error)}` }],
      details: { presetFailed: true, observationStorageFailed: true, envelope: { ...envelope, ok: false }, preset },
    };
  }
}
