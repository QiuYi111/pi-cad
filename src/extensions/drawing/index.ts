import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { drawingCommand } from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { selectKernelEngine } from "../../harness/engine-router.ts";
import { executeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

const ViewName = Type.Enum({
  iso: "iso",
  front: "front",
  back: "back",
  left: "left",
  right: "right",
  top: "top",
  bottom: "bottom",
});

function legacyInspectableUnion(recipe: any, legacy: any): any {
  return { ...Type.Union([recipe, legacy]), properties: legacy.properties };
}

export default function cadDrawingExtension(pi: ExtensionAPI) {
  registerMechanicalActionTool(pi, {
    name: "cad_generate_drawing",
    label: "CAD Generate Drawing",
    description:
      "Validate or generate a manufacturing drawing (DXF + SVG in the V0 backend). Pass artifact, views, dimensions, tolerances, and inspection methods directly; the harness canonicalizes the spec into run-scoped evidence storage itself. The tool executes the spec; it does not decide whether dimensions/tolerances are complete. PDF and standards-compliant GD&T symbols are explicitly unavailable in this backend.",
    promptSnippet: "Validate or generate a manufacturing drawing",
    promptGuidelines: [
      "Supply artifact, views, dimensions with tolerances, feature refs, and inspection methods explicitly; unknown view names are rejected.",
      "A projection without complete manufacturing definition is not a release drawing.",
      "Treat generated files as execution evidence, not automatic drawing completeness.",
    ],
    parameters: legacyInspectableUnion(
      Type.Object({ recipe: Type.String({ minLength: 1 }), obligationRef: Type.Optional(Type.String({ minLength: 1 })), stage: Type.Enum({ validate: "validate", generate: "generate" }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
      Type.Object({
        stage: Type.Enum({ validate: "validate", generate: "generate" }),
        artifact: Type.String({ description: "STEP artifact the drawing documents" }),
        units: Type.Optional(Type.Literal("mm")),
        sheet: Type.Optional(
          Type.Object(
            {
              width: Type.Number({ exclusiveMinimum: 0 }),
              height: Type.Number({ exclusiveMinimum: 0 }),
            },
            { additionalProperties: false },
          ),
        ),
        views: Type.Array(
          Type.Object(
            {
              name: ViewName,
              scale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        dimensions: Type.Optional(
          Type.Array(
            Type.Object(
              {
                p1: Type.Tuple([Type.Number(), Type.Number()]),
                p2: Type.Tuple([Type.Number(), Type.Number()]),
                text: Type.String({ minLength: 1 }),
                featureRefs: Type.Optional(Type.Array(Type.String())),
                tolerance: Type.Optional(
                  Type.Object(
                    { lower: Type.Number(), upper: Type.Number() },
                    { additionalProperties: false },
                  ),
                ),
                inspectionMethod: Type.Optional(Type.String()),
                ctq: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        notes: Type.Optional(Type.Array(Type.String())),
      }, { additionalProperties: false }),
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        if (!("recipe" in params)) return { content: [{ type: "text", text: "cad_generate_drawing v7 requires {recipe, stage}" }] };
        try {
          const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "drawing", recipe: params.recipe, action: params.stage, ...(params.obligationRef ? { obligationRef: params.obligationRef } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
          return { content: [{ type: "text", text: `Drawing Recipe ${result.record.runId} stage=${params.stage} committed; exports=${result.observation.exports.map((item) => item.name).join(",")}.` }], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, kind: "drawing" as const } };
        } catch (error) { return { content: [{ type: "text", text: `cad_generate_drawing failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      if ("recipe" in params) return { content: [{ type: "text", text: "cad_generate_drawing v6 requires a structured drawing specification" }] };
      if (!existsSync(resolve(ctx.cwd, params.artifact))) {
        throw new Error(`drawing artifact does not exist: ${params.artifact}`);
      }
      // The drawing backend resolves a relative artifact against the spec
      // directory, so the canonicalized spec stores an absolute path.
      const spec = {
        artifact: resolve(ctx.cwd, params.artifact),
        units: params.units ?? "mm",
        ...(params.sheet ? { sheet: params.sheet } : {}),
        views: params.views.map((view) => ({
          name: view.name,
          ...(view.scale !== undefined ? { scale: view.scale } : {}),
        })),
        ...(params.dimensions
          ? {
              dimensions: params.dimensions.map((dim) => ({
                p1: dim.p1,
                p2: dim.p2,
                text: dim.text,
                ...(dim.featureRefs ? { feature_refs: dim.featureRefs } : {}),
                ...(dim.tolerance ? { tolerance: dim.tolerance } : {}),
                ...(dim.inspectionMethod ? { inspection_method: dim.inspectionMethod } : {}),
                ...(dim.ctq !== undefined ? { ctq: dim.ctq } : {}),
              })),
            }
          : {}),
        ...(params.notes ? { notes: params.notes } : {}),
      };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "drawing", spec);
      const envelope = await drawingCommand(ctx.cwd, params.stage, specPath, outputDir);
      const payload = envelope.payload as { status?: string; error?: string; warnings?: string[]; outputs?: string[] };
      const text = envelope.ok
        ? `cad_generate_drawing stage=${params.stage} status=${payload.status ?? "ok"}\noutputs=${JSON.stringify(payload.outputs ?? [])}\nwarnings=${JSON.stringify(payload.warnings ?? [])}`
        : `cad_generate_drawing failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.spec,
          kind: "drawing" as const,
        },
      };
    },
  });
}
