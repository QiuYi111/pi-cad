import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { imageContent, presentationCommand } from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { selectKernelEngine } from "../../harness/engine-router.ts";
import { executeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

function legacyInspectableUnion(recipe: any, legacy: any): any {
  return { ...Type.Union([recipe, legacy]), properties: legacy.properties };
}

export default function cadPresentationExtension(pi: ExtensionAPI) {
  registerMechanicalActionTool(pi, {
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
    parameters: legacyInspectableUnion(
      Type.Object({ recipe: Type.String({ minLength: 1 }), obligationRef: Type.Optional(Type.String({ minLength: 1 })), stage: Type.Enum({ validate: "validate", preview: "preview", generate: "generate", run: "run" }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
      Type.Object({
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
      { additionalProperties: false }),
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        if (!("recipe" in params)) return { content: [{ type: "text", text: "cad_render_scene v7 requires {recipe, stage}" }] };
        try {
          const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "presentation", recipe: params.recipe, action: params.stage, ...(params.obligationRef ? { obligationRef: params.obligationRef } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
          const previewParts = params.stage === "preview"
            ? await Promise.all(result.observation.exports.filter((item) => item.type === "image" && item.path).map((item) => imageContent(resolve(result.directory, "workspace", item.path!))))
            : [];
          return { content: [{ type: "text", text: `Presentation Recipe ${result.record.runId} stage=${params.stage} committed; exports=${result.observation.exports.map((item) => item.name).join(",")}.` }, ...previewParts], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, kind: "presentation" as const } };
        } catch (error) { return { content: [{ type: "text", text: `cad_render_scene failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      if ("recipe" in params) return { content: [{ type: "text", text: "cad_render_scene v6 requires a structured presentation specification" }] };
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
        previewImages?: string[];
        manifest?: string;
        error?: string;
      };
      const text = envelope.ok
        ? `cad_render_scene stage=${params.stage} status=${payload.status ?? "ok"}${payload.reason ? `\nreason=${payload.reason}` : ""}\noutputs=${JSON.stringify(payload.outputs ?? [])}${payload.stage === "preview" && (payload.previewImages ?? []).length ? `\npreview images attached — inspect them yourself before committing to the final run.` : ""}`
        : `cad_render_scene failed: ${payload.error ?? "unknown error"}`;
      // Preview pixels come back multimodally: the preview -> inspect ->
      // revise loop needs the images in the conversation, not just paths.
      const previewParts =
        envelope.ok && params.stage === "preview"
          ? await Promise.all(
              (payload.previewImages ?? []).map((path) => imageContent(path)),
            )
          : [];
      // Presentation evidence binds to the presented DESIGN; the spec is a
      // hash-bound input alongside it.
      const artifactHash =
        envelope.inputHashes.artifact ??
        (envelope.inputArtifacts ?? []).find((input) => input.role === "artifact")?.sha256;
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text },
      ];
      for (const part of previewParts) {
        if (part) content.push(part);
      }
      return {
        content,
        details: {
          envelope,
          artifactHash: artifactHash ?? envelope.inputHashes.spec,
          kind: "presentation" as const,
        },
      };
    },
  });
}
