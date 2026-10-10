import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { MECHANICAL_ACTION_PARAMETERS } from "../../domains/mechanical/action-schemas.ts";
import { resolve } from "node:path";

import { imageContent } from "../../shared/image-content.ts";
import { executeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_render_scene,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await executeMechanicalRecipeV7({ cwd: ctx.cwd, kind: "presentation", recipe: params.recipe, action: params.stage, ...(params.obligationRef ? { obligationRef: params.obligationRef } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
        const previewParts = params.stage === "preview"
          ? await Promise.all(result.observation.exports.filter((item) => item.type === "image" && item.path).map((item) => imageContent(resolve(result.directory, "workspace", item.path!))))
          : [];
        return { content: [{ type: "text", text: `Presentation Recipe ${result.record.runId} stage=${params.stage} committed; exports=${result.observation.exports.map((item) => item.name).join(",")}.` }, ...previewParts], details: { recipeRunId: result.record.runId, observationId: result.observation.observationId, kind: "presentation" as const } };
      } catch (error) { return { content: [{ type: "text", text: `cad_render_scene failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });
}
