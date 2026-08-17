import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";

import {
  artifactPathForKind,
  buildPayload,
  buildStep,
  defaultBuildOutput,
  defaultGeometryEvidencePath,
  envelopeArtifactHash,
  geometryPayload,
  hashOrEmpty,
  inspectGeometry,
  measure,
  measurePayload,
} from "../../shared/capability.ts";
import type { CadEventEnvelope } from "../../shared/protocol.ts";

const artifactParam = Type.String({
  description: "Path to the STEP/STP artifact to inspect, relative to the project root",
});
const sourceParam = Type.String({
  description: "Path to the build123d Python source to execute, relative to the project root",
});
const outputParam = Type.String({
  description: "Output STEP path. Defaults to build/<source-stem>.step",
});

function envelopeText(envelope: CadEventEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export default function cadGeometryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_build_step",
    label: "CAD Build STEP",
    description:
      "Execute a build123d Python source and produce a STEP artifact. This tool has no engineering opinion: it returns exit code, paths, hashes, and logs. It does not judge whether the geometry is correct.",
    promptSnippet: "Execute build123d source and write a deterministic STEP artifact",
    promptGuidelines: [
      "Prefer cad_commit_candidate in the build phase; the harness runs this automatically and binds evidence to the candidate.",
      "The source must expose a build123d Shape as `result`, or call cadctl gen_step(result, output).",
    ],
    parameters: Type.Object({
      source: sourceParam,
      output: Type.Optional(outputParam),
      force: Type.Optional(Type.Boolean({ description: "Regenerate even if outputs exist" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = params.output ?? defaultBuildOutput(ctx.cwd, params.source);
      const sourceHash = await hashOrEmpty(resolve(ctx.cwd, params.source));
      const envelope = await buildStep(ctx.cwd, {
        source: params.source,
        output,
        force: params.force ?? true,
      });
      const text = envelope.ok
        ? `cad_build_step ${envelope.ok ? "succeeded" : "failed"}.\n${envelopeText(envelope)}`
        : `cad_build_step failed: ${buildPayload(envelope).error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.ok ? envelopeArtifactHash(envelope, "step") : undefined,
          sourceHash,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_inspect_geometry",
    label: "CAD Inspect Geometry",
    description:
      "Return deterministic STEP/B-Rep facts: bbox, volume, surface area, solid count, occurrence count, and labels/planes/cylinders. Geometry classification is not engineering naming; a cylinder is only #cN.",
    promptSnippet: "Return deterministic geometry facts for a STEP artifact",
    promptGuidelines: [
      "Use #pN and #cN labels from the returned payload as selectors for cad_measure.",
      "Interpret what those faces mean yourself; this tool will not.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      output: Type.Optional(Type.String({ description: "Optional JSON evidence output path" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = params.output ?? defaultGeometryEvidencePath(ctx.cwd, params.artifact);
      const envelope = await inspectGeometry(ctx.cwd, params.artifact, output);
      const payload = geometryPayload(envelope);
      const text = envelope.ok
        ? `cad_inspect_geometry succeeded.\n${envelopeText(envelope)}`
        : `cad_inspect_geometry failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "geometry" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_measure",
    label: "CAD Measure",
    description:
      "Return one deterministic numeric measurement for an explicit selector and metric. Cylindrical faces use #cN. distance between two cylindrical faces is axis-to-axis distance; use clearance for closest surface distance. Other selectors: #pN planar face, #fN any face.",
    promptSnippet: "Measure one explicit metric between labeled STEP selectors",
    promptGuidelines: [
      "Selectors are #pN (planar), #cN (cylindrical), or #fN (any face) from cad_inspect_geometry.",
      "For hole centers use metric=distance with two #cN cylindrical faces.",
      "Verify every user-specified critical dimension before accepting a candidate.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      metric: Type.Enum({
        distance: "distance",
        clearance: "clearance",
        radius: "radius",
        diameter: "diameter",
        area: "area",
        volume: "volume",
        bbox: "bbox",
        frame: "frame",
        alignment_delta: "alignment_delta",
      }),
      a: Type.String({ description: "First selector, e.g. #c0" }),
      b: Type.Optional(Type.String({ description: "Second selector for two-selector metrics" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await measure(ctx.cwd, params.artifact, {
        metric: params.metric,
        a: params.a,
        b: params.b,
      });
      const payload = measurePayload(envelope);
      const text = envelope.ok
        ? `cad_measure ${payload.metric}(${payload.a}${payload.b ? `, ${payload.b}` : ""}) = ${JSON.stringify(payload.value)} ${payload.units ?? "mm"}`
        : `cad_measure failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact,
          kind: "measure" as const,
        },
      };
    },
  });
}
