import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { Type } from "typebox";

import cadSimulationV2Extension from "./v2.ts";
import { executeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

export default function cadSimulationExtension(pi: ExtensionAPI) {
  cadSimulationV2Extension(pi);

  registerMechanicalActionTool(pi, {
    name: "cad_derive_analysis_model",
    label: "CAD Derive Analysis Model",
    description:
      "Create a hash-bound analysis-model derivation from the authoritative design. The harness executes fused/bonded derivations; authored simplifications preserve both source and output provenance for Recipe inputs.",
    promptSnippet: "Derive a verified analysis model from the canonical design",
    promptGuidelines: [
      "Use fused/bonded when a solver needs an assembly as one solid; the harness performs the union.",
      "Use simplified/defeatured/sectioned only for an intentionally authored analysis model.",
      "Declare the derivation record and derived artifact as simulation Recipe inputs.",
    ],
    parameters: Type.Object({ recipe: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "analysis-model", recipe: params.recipe, ...(params.action ? { action: params.action } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
        return { content: [{ type: "text", text: `Analysis-model Recipe ${result.record.runId} committed ${result.observation.exports.length} exports.` }], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, kind: "build" as const } };
      } catch (error) { return { content: [{ type: "text", text: `cad_derive_analysis_model failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_optimize",
    label: "CAD Optimize",
    description:
      "Run the deterministic differentiable 2D rectangular topology optimization skeleton in the managed torch-fem runtime. It returns density/surface artifacts, does not update Project Head, and does not create Simulation Evidence.",
    promptSnippet: "Run managed differentiable topology optimization (SIMP + MMA)",
    promptGuidelines: [
      "Use only for a 2D rectangular topology domain.",
      "Optimization output is not CAD; reconstruct it as build123d geometry and commit a candidate.",
      "Accepted CAD must be simulated again before engineering acceptance.",
    ],
    parameters: Type.Object({ recipe: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "optimization", recipe: params.recipe, ...(params.action ? { action: params.action } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
        return { content: [{ type: "text", text: `Optimization Recipe ${result.record.runId} committed; exports=${result.observation.exports.map((item) => item.name).join(",")}. Output is not accepted CAD.` }], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, computeIdentity: result.record.computeIdentity, kind: "optimization" as const } };
      } catch (error) { return { content: [{ type: "text", text: `cad_optimize failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });
}
