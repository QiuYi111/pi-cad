import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";

import {
  buildPayload,
  defaultBuildOutput,
  envelopeArtifactHash,
  hashOrEmpty,
} from "../../shared/capability.ts";
import { renderProbeResult } from "../../modules/probe/index.ts";
import { modelBackend } from "../../modules/model/index.ts";

const sourceParam = Type.String({
  description: "Path to the build123d Python source to execute, relative to the project root",
});
const outputParam = Type.String({
  description: "Output STEP path. Defaults to build/<source-stem>.step",
});

export default function cadGeometryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_build_step",
    label: "CAD Build STEP",
    description:
      "Execute a build123d Python source and produce a STEP artifact. This tool returns deterministic paths, hashes, and logs; it does not judge geometry or engineering fitness.",
    promptSnippet: "Execute build123d source and write a deterministic STEP artifact",
    promptGuidelines: [
      "Prefer cad_commit_candidate in source phases; the harness builds and binds candidate evidence automatically.",
      "The source must expose a build123d Shape as result, or call cadctl gen_step(result, output).",
    ],
    parameters: Type.Object({
      source: sourceParam,
      output: Type.Optional(outputParam),
      force: Type.Optional(Type.Boolean({ description: "Regenerate even if outputs exist" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = params.output ?? defaultBuildOutput(ctx.cwd, params.source);
      const sourceHash = await hashOrEmpty(resolve(ctx.cwd, params.source));
      const envelope = await modelBackend().build(ctx.cwd, {
        source: params.source,
        output,
        force: params.force ?? true,
      });
      if (!envelope.ok) {
        return {
          content: [{ type: "text", text: `cad_build_step failed: ${buildPayload(envelope).error ?? "unknown error"}` }],
          details: { envelope, sourceHash },
        };
      }
      const { content, details } = await renderProbeResult(
        {
          envelope,
          headline: `cad_build_step: ${params.source} → ${output}`,
          artifactHashFrom: "source",
          extraDetails: { artifactHash: envelopeArtifactHash(envelope, "step"), sourceHash },
        },
        "cad_build_step",
      );
      return { content, details };
    },
  });

  pi.registerTool({
    name: "cad_export",
    label: "CAD Export",
    description:
      "Export a STEP artifact or build123d source to step, stl, glb, or brep. STEP remains authoritative; exported formats are delivery sidecars.",
    promptSnippet: "Export a source or artifact to an explicit format",
    promptGuidelines: [
      "STEP remains the primary artifact; other formats are sidecars.",
      "Do not use export to patch design intent into a mesh.",
    ],
    parameters: Type.Object({
      source: Type.String(),
      output: Type.String(),
      format: Type.Enum({ step: "step", stl: "stl", glb: "glb", brep: "brep" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await modelBackend().export(ctx.cwd, params);
      if (!envelope.ok) {
        const error = (envelope.payload as { error?: string }).error;
        return { content: [{ type: "text", text: `cad_export failed: ${error ?? "unknown error"}` }], details: { envelope } };
      }
      const payload = envelope.payload as { output?: string };
      return renderProbeResult(
        {
          envelope,
          headline: `cad_export succeeded: ${payload.output ?? params.output}`,
          includeEnvelope: false,
          artifactHashFrom: "source",
          extraDetails: { artifactHash: envelope.artifacts[0]?.sha256 ?? envelope.inputHashes.source, kind: "export" },
        },
        "cad_export",
      );
    },
  });
}
