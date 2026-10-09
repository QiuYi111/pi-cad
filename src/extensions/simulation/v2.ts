import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { Type } from "typebox";

import { cadSimulateV7, commitMechanicalRecipeByRefV7, observeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

export const CadSimulateParametersSchema = Type.Object({ recipe: Type.String({ minLength: 1, description: "v7 directory containing pi-recipe.yaml" }), obligationRef: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false });
export const CadSimObserveParametersSchema = Type.Object({ run: Type.String({ minLength: 1 }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false });
export const CadCommitSimulationParametersSchema = Type.Object({ run: Type.String({ minLength: 1 }), observation: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export default function cadSimulationV2Extension(pi: ExtensionAPI): void {
  registerMechanicalActionTool(pi, {
    name: "cad_simulate",
    label: "CAD Simulate Recipe",
    description: "Run an agent-authored solver-native Recipe in a managed backend/runtime and return a controlled multimodal Observation. The Recipe owns physics, configuration, meshing, execution, and project-specific postprocessing. Pi-CAD freezes the Recipe and every explicitly declared input, runs without implicit project access, validates generic exports, returns images before bounded quantitative context and diagnostics, and retains raw artifacts/logs. This creates an immutable SimulationRun and ObservationSnapshot but never Evidence; use cad_commit_simulation after inspection.",
    promptSnippet: "Execute a Recipe-native simulation and observe its declared exports",
    promptGuidelines: ["Author or revise solver-native Recipes only under simulation/**; never encode physics in tool arguments.", "Declare every external project input in pi-sim.toml and choose a backend/runtime advertised in context.", "Inspect the images-first Observation and quantitative health. A successful solve is not Evidence until cad_commit_simulation."],
    parameters: CadSimulateParametersSchema,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const result = await cadSimulateV7({ cwd: ctx.cwd, recipe: params.recipe, obligationRef: params.obligationRef, ...(params.action ? { action: params.action } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
        return { content: [{ type: "text", text: `Simulation Recipe ${result.record.runId} ${result.record.status}; obligation=${params.obligationRef}. Call cad_sim_observe with this run.` }], details: { simulationRunId: result.record.runId, computeIdentity: result.record.computeIdentity, validForCommit: false } };
      } catch (error) { return { content: [{ type: "text", text: `cad_simulate failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_sim_observe",
    label: "CAD Re-observe Simulation",
    description: "Run only the observation program over one frozen SimulationRun and create a new immutable ObservationSnapshot without rerunning compute. Only the originally declared observation_files plus observe/export declarations may change; solver, mesh, entrypoint, inputs, runtime, and frozen raw state must still match.",
    promptSnippet: "Re-run a simulation Recipe's observation program",
    promptGuidelines: ["Use this after editing only declared observation_files.", "Changing solver, mesh, entrypoint, or inputs requires cad_simulate."],
    parameters: CadSimObserveParametersSchema,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const observation = await observeMechanicalRecipeV7({ cwd: ctx.cwd, run: params.run, signal: _signal });
        return { content: [{ type: "text", text: `Observation ${observation.observationId} validForCommit=${observation.validForCommit}; exports=${observation.exports.map((item) => item.name).join(",")}` }], details: { simulationRunId: params.run, observationId: observation.observationId, validForCommit: observation.validForCommit } };
      } catch (error) { return { content: [{ type: "text", text: `cad_sim_observe failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_commit_simulation",
    label: "Commit Simulation Evidence",
    description: "Promote one successfully completed managed SimulationRun and one exact valid ObservationSnapshot into version-bound Evidence for an existing case whose declared tool is cad_simulate. Pi-CAD re-verifies the frozen raw state, Recipe, runtime identity, all declared inputs, observation artifacts/program, and authoritative design or verified derivation. This performs no solve or postprocessing and does not judge engineering PASS.",
    promptSnippet: "Commit a validated simulation Observation as case-scoped Evidence",
    promptGuidelines: ["Commit only after inspecting the Observation.", "Evidence records provenance; it does not imply an engineering PASS."],
    parameters: CadCommitSimulationParametersSchema,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const committed = await commitMechanicalRecipeByRefV7({ cwd: ctx.cwd, run: params.run, observation: params.observation });
        const evidence = committed.state.evidence.find((item) => item.computeIdentity);
        return { content: [{ type: "text", text: `Committed pre-bound Simulation Evidence ${evidence?.id ?? "(idempotent)"}.` }], details: { evidenceId: evidence?.id, simulationRunId: params.run, observationId: params.observation } };
      } catch (error) { return { content: [{ type: "text", text: `cad_commit_simulation failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });
}
