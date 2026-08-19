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
      "Validate, preview, generate, or run a product presentation. Pass artifact, reference-backed directions, materials, lighting, and camera directly; the assembly definition (from the committed assembly_design record) drives the exploded view and assembly animation. Preview renders fast keyframes for your own inspection before the final run; run produces hero/exploded PNGs, turntable and assembly MP4s, presentation.blend, and a hash-bound manifest. The tool does not judge aesthetic quality.",
    promptSnippet: "Validate/preview/generate/run a presentation scene",
    promptGuidelines: [
      "Supply at least two reference-backed visual directions plus materials, lighting, and camera explicitly.",
      "A technically correct default render is not release-quality presentation.",
      "Inspect a preview before committing to the final run; both are honest evidence states.",
      "Carry the committed assembly_design sequence and explode directions into assemblyDefinition so the animation matches the real install order.",
      "unavailable/failed are honest states; never describe a scene description as a render.",
    ],
    parameters: Type.Object(
      {
        stage: Type.Enum({ validate: "validate", preview: "preview", generate: "generate", run: "run" }),
        artifact: Type.String({ description: "Artifact (STEP or GLB) the scene presents — the evidence subject" }),
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
        assemblyDefinition: Type.Optional(
          Type.Object(
            {
              sequence: Type.Array(
                Type.Object(
                  {
                    step: Type.Number(),
                    installs: Type.Array(Type.String(), { minItems: 1 }),
                  },
                  { additionalProperties: false },
                ),
                { minItems: 1, description: "Install order from the committed assembly_design record" },
              ),
              modules: Type.Optional(
                Type.Array(
                  Type.Object(
                    {
                      name: Type.String(),
                      envelopeMm: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
                    },
                    { additionalProperties: false },
                  ),
                ),
              ),
              explodeDirections: Type.Optional(
                Type.Record(Type.String(), Type.Tuple([Type.Number(), Type.Number(), Type.Number()]), {
                  description: "Module name -> unit-ish explode direction; unmatched objects explode radially",
                }),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        resolution: Type.Optional(
          Type.Object(
            { width: Type.Integer({ minimum: 16 }), height: Type.Integer({ minimum: 16 }) },
            { additionalProperties: false },
          ),
        ),
        fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
        outputs: Type.Optional(
          Type.Object(
            {
              hero: Type.Optional(Type.Boolean()),
              exploded: Type.Optional(Type.Boolean()),
              turntable: Type.Optional(Type.Boolean()),
              assembly: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      // Unknown keys fail closed at the tool boundary.
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
        ...(params.assemblyDefinition ? { assemblyDefinition: params.assemblyDefinition } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        ...(params.fps ? { fps: params.fps } : {}),
        ...(params.outputs ? { outputs: params.outputs } : {}),
      };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "presentation", spec);
      const envelope = await presentationCommand(ctx.cwd, params.stage, specPath, outputDir);
      const payload = envelope.payload as {
        status?: string;
        stage?: string;
        reason?: string;
        outputs?: string[];
        manifest?: string;
        error?: string;
      };
      const text = envelope.ok
        ? `cad_render_scene stage=${params.stage} status=${payload.status ?? "ok"}${payload.reason ? `\nreason=${payload.reason}` : ""}\noutputs=${JSON.stringify(payload.outputs ?? [])}`
        : `cad_render_scene failed: ${payload.error ?? "unknown error"}`;
      // Presentation evidence binds to the presented DESIGN; the spec is a
      // hash-bound input alongside it.
      const artifactHash =
        envelope.inputHashes.artifact ??
        (envelope.inputArtifacts ?? []).find((input) => input.role === "artifact")?.sha256;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: artifactHash ?? envelope.inputHashes.spec,
          kind: "presentation" as const,
        },
      };
    },
  });
}
