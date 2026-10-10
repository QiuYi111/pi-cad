import { jsonValue } from "../harness/canonical.ts";
import { workflowCurrentView } from "../harness/card.ts";
import { cadStartSnapshot } from "../harness/kernel.ts";
import { transitionRun } from "../harness/reducer.ts";
import { HarnessRunStoreV7 } from "../harness/run-store.ts";
import { resolveActiveRun } from "../harness/run-scope.ts";
import { workflowRunStateView } from "../harness/workflow/phase-view.ts";
import { discoverWorkflowPackages, resolveWorkflowPackage } from "../harness/workflow/packages.ts";
import { executeWorkflowGitActions, phaseGitActions, prepareWorkflowGit, type WorkflowGitResult } from "../harness/workflow-git.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";

async function current(cwd: string) {
  const loaded = await resolveActiveRun(cwd, mechanicalRegistries);
  if (!loaded) return null;
  const view = workflowCurrentView(loaded, mechanicalRegistries);
  // A conversation-scoped caller is answered for its own run only. The phase
  // picture travels with the view so a client (the Desktop workflow rail) can
  // render every phase without deriving statuses itself.
  return jsonValue({ ...view, ...workflowRunStateView(loaded, view) });
}

export async function recordGitResults(store: HarnessRunStoreV7, results: WorkflowGitResult[], moment: string): Promise<void> {
  if (!results.length) return;
  await store.mutate(mechanicalRegistries, ({ state }) => ({
    state,
    event: { type: "WorkflowGitActionsCompleted", data: jsonValue({ moment, results }) },
  }));
}

export async function workflowList(cwd: string) {
  const packages = await discoverWorkflowPackages(cwd, mechanicalRegistries);
  return jsonValue(packages.map(({ id, description, tags, version }) => ({ id, description, tags, version })));
}

export async function workflowCurrent(cwd: string) {
  return jsonValue(await current(cwd));
}

export async function workflowStart(cwd: string, request: Extract<AgentApiRequest, { op: "workflow-start" }>) {
  const selected = await resolveWorkflowPackage(cwd, request.id, mechanicalRegistries);
  const startResults = await prepareWorkflowGit(cwd, selected.workflow);
  const enterResults = await executeWorkflowGitActions(cwd, selected.workflow, phaseGitActions(selected.workflow, selected.workflow.initialPhase, "onEnter"), `enter ${selected.workflow.initialPhase}`);
  const started = await cadStartSnapshot({
    cwd, registries: mechanicalRegistries, workflow: selected.workflow,
    interactionMode: request.interactionMode ?? "interactive",
  });
  const store = new HarnessRunStoreV7(cwd, started.state.runId);
  await recordGitResults(store, startResults, "workflow-start");
  await recordGitResults(store, enterResults, `enter:${started.state.phase}`);
  // The new run is the answer even when the caller's conversation scope
  // was unbound at the moment it asked to start.
  const fresh = await store.load(mechanicalRegistries) ?? started;
  return jsonValue(workflowCurrentView(fresh, mechanicalRegistries));
}

export async function workflowAdvance(cwd: string, request: Extract<AgentApiRequest, { op: "workflow-advance" }>) {
  if (!request.event?.trim()) throw new Error("workflow event is required");
  const active = await resolveActiveRun(cwd, mechanicalRegistries);
  if (!active) throw new Error("no active Pi-CAD v7 run");
  const store = new HarnessRunStoreV7(cwd, active.state.runId);
  // Validate the state transition before producing any external Git side effect.
  transitionRun(active.state, active.workflow, request.event);
  const exitResults = await executeWorkflowGitActions(cwd, active.workflow, phaseGitActions(active.workflow, active.state.phase, "onExit"), `complete ${active.state.phase}`);
  await recordGitResults(store, exitResults, `exit:${active.state.phase}`);
  const next = await store.mutate(mechanicalRegistries, (loaded) => ({ state: transitionRun(loaded.state, loaded.workflow, request.event), event: { type: "WorkflowAdvancedByAgentApi", data: { event: request.event } } }));
  const enterResults = await executeWorkflowGitActions(cwd, next.workflow, phaseGitActions(next.workflow, next.state.phase, "onEnter"), `enter ${next.state.phase}`);
  await recordGitResults(store, enterResults, `enter:${next.state.phase}`);
  return jsonValue({ phase: next.state.phase, status: next.state.status });
}

export async function reviewCurrent(cwd: string) {
  const active = await resolveActiveRun(cwd, mechanicalRegistries);
  if (!active) return null;
  return jsonValue({ expectedProfile: active.workflow.phases[active.state.phase]?.reviewProfile ?? null, latest: active.state.latestReview ?? null });
}
