import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { Type } from "typebox";

import { executeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

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
    parameters: Type.Object({ recipe: Type.String({ minLength: 1 }), obligationRef: Type.Optional(Type.String({ minLength: 1 })), stage: Type.Enum({ validate: "validate", generate: "generate" }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "drawing", recipe: params.recipe, action: params.stage, ...(params.obligationRef ? { obligationRef: params.obligationRef } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
        return { content: [{ type: "text", text: `Drawing Recipe ${result.record.runId} stage=${params.stage} committed; exports=${result.observation.exports.map((item) => item.name).join(",")}.` }], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, kind: "drawing" as const } };
      } catch (error) { return { content: [{ type: "text", text: `cad_generate_drawing failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });
}
