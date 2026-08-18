import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { presentationCommand } from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";

export default function cadPresentationExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_render_scene",
    label: "CAD Render Scene",
    description:
      "Validate, generate, or run a product presentation scene. Pass artifact, reference-backed directions, materials, lighting, and camera directly; the harness canonicalizes the spec into run-scoped evidence storage itself. Generate always writes the deterministic scene script; run returns explicit unavailable when Blender/FFmpeg are missing. The tool does not judge aesthetic quality.",
    promptSnippet: "Validate/generate/run a presentation scene",
    promptGuidelines: [
      "Supply at least two reference-backed visual directions plus materials, lighting, and camera explicitly.",
      "A technically correct default render is not release-quality presentation.",
      "script-generated and unavailable are honest evidence states.",
    ],
    parameters: Type.Object(
      {
        stage: Type.Enum({ validate: "validate", generate: "generate", run: "run" }),
        artifact: Type.String({ description: "Artifact (e.g. GLB export) the scene presents" }),
        directions: Type.Array(
          Type.Object(
            {
              name: Type.String({ minLength: 1 }),
              reference: Type.String({ description: "Path to a reference image backing this direction" }),
            },
            { additionalProperties: false },
          ),
          { minItems: 2 },
        ),
        materials: Type.Array(
          Type.Object(
            {
              pattern: Type.String(),
              family: Type.String(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        lighting: Type.Object(
          {
            key: Type.String(),
            fill: Type.String(),
            rim: Type.String(),
          },
          { additionalProperties: false },
        ),
        camera: Type.Object(
          {
            lens: Type.String(),
            composition: Type.String(),
          },
          { additionalProperties: false },
        ),
        outputs: Type.Optional(
          Type.Object(
            {
              hero: Type.Optional(Type.String()),
              turntable: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!existsSync(resolve(ctx.cwd, params.artifact))) {
        throw new Error(`presentation artifact does not exist: ${params.artifact}`);
      }
      for (const direction of params.directions) {
        if (!existsSync(resolve(ctx.cwd, direction.reference))) {
          throw new Error(`presentation direction reference does not exist: ${direction.reference}`);
        }
      }
      const spec = {
        artifact: resolve(ctx.cwd, params.artifact),
        directions: params.directions.map((direction) => ({
          name: direction.name,
          reference: resolve(ctx.cwd, direction.reference),
        })),
        materials: params.materials,
        lighting: params.lighting,
        camera: params.camera,
        ...(params.outputs ? { outputs: params.outputs } : {}),
      };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "presentation", spec);
      const envelope = await presentationCommand(ctx.cwd, params.stage, specPath, outputDir);
      const payload = envelope.payload as { status?: string; reason?: string; outputs?: string[]; error?: string };
      const text = envelope.ok
        ? `cad_render_scene stage=${params.stage} status=${payload.status ?? "ok"}${payload.reason ? `\nreason=${payload.reason}` : ""}\noutputs=${JSON.stringify(payload.outputs ?? [])}`
        : `cad_render_scene failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.spec,
          kind: "presentation" as const,
        },
      };
    },
  });
}
