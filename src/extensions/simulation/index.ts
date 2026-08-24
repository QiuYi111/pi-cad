import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { deriveAnalysisModel, optimizationCommand } from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { DeriveAnalysisModelSchema } from "./analysis-model.ts";
import cadSimulationV2Extension from "./v2.ts";
import { selectKernelEngine } from "../../harness/engine-router.ts";
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
    parameters: Type.Union([
      Type.Object({ recipe: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
      DeriveAnalysisModelSchema,
    ]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        if (!("recipe" in params)) return { content: [{ type: "text", text: "cad_derive_analysis_model v7 requires {recipe}" }] };
        try {
          const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "analysis-model", recipe: params.recipe, ...(params.action ? { action: params.action } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
          return { content: [{ type: "text", text: `Analysis-model Recipe ${result.record.runId} committed ${result.observation.exports.length} exports.` }], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, kind: "build" as const } };
        } catch (error) { return { content: [{ type: "text", text: `cad_derive_analysis_model failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      if ("recipe" in params) return { content: [{ type: "text", text: "cad_derive_analysis_model v6 requires source/operations" }] };
      if (!existsSync(resolve(ctx.cwd, params.source))) throw new Error(`derivation source does not exist: ${params.source}`);
      if (params.output && !existsSync(resolve(ctx.cwd, params.output))) {
        const mechanical = params.operations.every((op) => op === "fused" || op === "bonded");
        if (!mechanical) throw new Error(`authored derivations require an existing output: ${params.output}`);
      }
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "derivation", params);
      const envelope = await deriveAnalysisModel(ctx.cwd, specPath, outputDir, 3_600_000);
      const payload = envelope.payload as { error?: string; recordPath?: string; executed?: boolean };
      const text = envelope.ok
        ? `cad_derive_analysis_model: derivation record ${payload.recordPath} (${payload.executed ? "harness-executed" : "authored"}). Declare the record and output in pi-sim.toml inputs.`
        : `cad_derive_analysis_model failed: ${payload.error ?? "unknown error"}`;
      return { content: [{ type: "text", text }], details: { envelope, kind: "build" as const } };
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
    parameters: Type.Union([
      Type.Object({ recipe: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
      Type.Object({
        mode: Type.Optional(Type.Literal("topology_2d_rect_v0")),
        runtime: Type.Optional(Type.Enum({
          cuda: "torch-fem-0.9-cu126",
          cpu: "torch-fem-0.9-cpu",
        }, { description: "Managed torch-fem runtime; CUDA is the production default and never falls back to CPU" })),
        designDomain: Type.Object(
          {
            x: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
            y: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
            nx: Type.Optional(Type.Integer({ minimum: 2 })),
            ny: Type.Optional(Type.Integer({ minimum: 2 })),
          },
          { additionalProperties: false },
        ),
        material: Type.Object({ E: Type.Number(), nu: Type.Number() }, { additionalProperties: false }),
        objective: Type.Object({ type: Type.Literal("compliance"), sense: Type.Literal("minimize") }, { additionalProperties: false }),
        constraints: Type.Array(
          Type.Object({ type: Type.Literal("volume_fraction"), max: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) }, { additionalProperties: false }),
          { minItems: 1, maxItems: 1 },
        ),
        optimizer: Type.Object(
          {
            type: Type.Literal("mma"),
            maxIterations: Type.Integer({ minimum: 1 }),
            penalty: Type.Optional(Type.Number({ exclusiveMinimum: 1 })),
            Emin: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          },
          { additionalProperties: false },
        ),
      }, { additionalProperties: false }),
    ]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        if (!("recipe" in params)) return { content: [{ type: "text", text: "cad_optimize v7 requires {recipe}" }] };
        try {
          const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "optimization", recipe: params.recipe, ...(params.action ? { action: params.action } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
          return { content: [{ type: "text", text: `Optimization Recipe ${result.record.runId} committed; exports=${result.observation.exports.map((item) => item.name).join(",")}. Output is not accepted CAD.` }], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, computeIdentity: result.record.computeIdentity, kind: "optimization" as const } };
        } catch (error) { return { content: [{ type: "text", text: `cad_optimize failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      if ("recipe" in params) return { content: [{ type: "text", text: "cad_optimize v6 requires a structured topology specification" }] };
      const { runtime = "torch-fem-0.9-cu126", ...rest } = params;
      const spec = { ...rest, mode: rest.mode ?? "topology_2d_rect_v0", device: runtime.endsWith("-cpu") ? "cpu" : "cuda" };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "optimization", spec);
      const envelope = await optimizationCommand(ctx.cwd, specPath, outputDir, runtime);
      const payload = envelope.payload as { bestObjective?: number; finalVolumeFraction?: number; iterations?: number; error?: string; reason?: string; actualDevice?: string };
      const text = envelope.ok
        ? `cad_optimize completed in ${runtime}: device=${payload.actualDevice ?? spec.device} iterations=${payload.iterations ?? "?"} bestObjective=${payload.bestObjective ?? "?"} finalVolumeFraction=${payload.finalVolumeFraction ?? "?"}\nThis is an optimization artifact, not CAD or Simulation Evidence.`
        : `cad_optimize failed in ${runtime}: ${payload.error ?? payload.reason ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: { envelope, artifactHash: envelope.inputHashes.spec, specHash: envelope.inputHashes.spec, kind: "optimization" as const },
      };
    },
  });
}
