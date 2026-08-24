import { jsonValue } from "../harness/canonical.ts";
import { commitWorkspace, loadWorkspaceCommit, workspaceHistory } from "../harness/commit.ts";
import { transitionRun, unmetPhaseObligations } from "../harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { executeCadProbe } from "../modules/probe/tool.ts";
import { buildStep } from "../shared/capability.ts";
import { executeMechanicalRecipeV7 } from "../domains/mechanical/recipe-actions-v7.ts";
import type { AgentApiRequest } from "./protocol.ts";
import { bootstrapAgentApiContracts } from "./bootstrap.ts";

async function current(cwd: string) {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!loaded) return null;
  const phase = loaded.workflow.phases[loaded.state.phase]!;
  return {
    runId: loaded.state.runId, workflowId: loaded.workflow.id, workflowHash: loaded.workflow.hash,
    phase: loaded.state.phase, purpose: phase.purpose, guidance: phase.guidance ?? null,
    status: loaded.state.status, unmet: unmetPhaseObligations(loaded.state, loaded.workflow),
    recommendedTemplates: phase.recommendedTemplates ?? [], recommendedSkills: phase.recommendedSkills ?? [],
  };
}

export async function handleAgentApi(cwd: string, request: AgentApiRequest) {
  bootstrapAgentApiContracts();
  if (!request || request.schema !== 1 || typeof request.op !== "string") throw new Error("invalid Agent API request");
  switch (request.op) {
    case "workflow-current": return jsonValue(await current(cwd));
    case "workflow-advance": {
      if (!request.event?.trim()) throw new Error("workflow event is required");
      const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
      if (!active) throw new Error("no active Pi-CAD v7 run");
      const store = new HarnessRunStoreV7(cwd, active.state.runId);
      const next = await store.mutate(mechanicalRegistries, (loaded) => ({ state: transitionRun(loaded.state, loaded.workflow, request.event), event: { type: "WorkflowAdvancedByAgentApi", data: { event: request.event } } }));
      return jsonValue({ phase: next.state.phase, status: next.state.status });
    }
    case "commit": return jsonValue(await commitWorkspace({ cwd, registries: mechanicalRegistries, name: request.name, variables: request.variables, artifacts: request.artifacts, session: request.session }));
    case "load": return jsonValue(await loadWorkspaceCommit(cwd, mechanicalRegistries, request.id));
    case "history": return jsonValue(await workspaceHistory(cwd, mechanicalRegistries));
    case "probe": {
      const rendered = await executeCadProbe(cwd, { preset: "python", subject: request.subject, purpose: request.purpose, code: request.code });
      const details = "details" in rendered ? rendered.details as any : undefined;
      const result = details?.envelope?.payload?.result;
      if (details?.presetFailed || result === undefined) throw new Error(rendered.content.map((item) => item.type === "text" ? item.text : "").join("\n") || "programmable probe failed");
      return jsonValue({ value: result, artifactHash: details.artifactHash ?? details.envelope?.inputHashes?.artifact, scriptHash: details.envelope?.inputHashes?.script, observationId: details.observationId });
    }
    case "model-build": return jsonValue(await buildStep(cwd, { source: request.source, output: request.output, force: request.force }));
    case "simulation-run": {
      const executed = await executeMechanicalRecipeV7({ cwd, kind: "simulation", recipe: request.recipe, action: request.action, obligationRef: request.obligationRef, outputs: request.outputs });
      return jsonValue({
        runId: executed.record.runId, recipeId: executed.record.recipeId, status: executed.record.status,
        computeIdentity: executed.record.computeIdentity, observation: executed.observation,
      });
    }
    case "review-current": {
      const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
      if (!active) return null;
      return jsonValue({ expectedProfile: active.workflow.phases[active.state.phase]?.reviewProfile ?? null, latest: active.state.latestReview ?? null });
    }
    default: throw new Error(`unsupported Agent API operation: ${(request as { op: string }).op}`);
  }
}
