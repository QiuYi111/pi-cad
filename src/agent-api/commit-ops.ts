import { jsonValue, type JsonValue } from "../harness/canonical.ts";
import { commitWorkspace, loadWorkspaceCommit, workspaceHistory } from "../harness/commit.ts";
import { HarnessRunStoreV7 } from "../harness/run-store.ts";
import { resolveActiveRun } from "../harness/run-scope.ts";
import { currentGitRevision, executeWorkflowGitActions, phaseGitActions } from "../harness/workflow-git.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";
import { recordGitResults } from "./workflow-ops.ts";

export async function commitWorkspaceOp(cwd: string, request: Extract<AgentApiRequest, { op: "commit" }>) {
  const active = await resolveActiveRun(cwd, mechanicalRegistries);
  const gitResults = active
    ? await executeWorkflowGitActions(cwd, active.workflow, phaseGitActions(active.workflow, active.state.phase, "onExit").filter((action) => action === "commit"), `record ${request.name}`)
    : [];
  const sourceRevision = active?.workflow.versionControl ? await currentGitRevision(cwd) : undefined;
  const manifest = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: request.name, ...(request.parent === undefined ? {} : { parent: request.parent }), variables: request.variables, artifacts: request.artifacts, session: request.session, acceptance: request.acceptance, ...(sourceRevision ? { sourceRevision } : {}) });
  if (active) await recordGitResults(new HarnessRunStoreV7(cwd, active.state.runId), gitResults, `record:${request.name}`);
  return jsonValue(manifest);
}

export async function loadCommit(cwd: string, request: Extract<AgentApiRequest, { op: "load" }>) {
  return jsonValue(await loadWorkspaceCommit(cwd, mechanicalRegistries, request.id));
}

export async function commitHistory(cwd: string) {
  return jsonValue(await workspaceHistory(cwd, mechanicalRegistries));
}

export async function evidenceRead(cwd: string, request: Extract<AgentApiRequest, { op: "evidence-read" }>) {
  if (!/^evidence\/[a-zA-Z0-9._/-]+\.json$/.test(request.path) || request.path.includes("..")) throw new Error("invalid evidence path");
  const active = await resolveActiveRun(cwd, mechanicalRegistries);
  if (!active) throw new Error("no active Pi-CAD v7 run");
  const value = await new HarnessRunStoreV7(cwd, active.state.runId).transactions.readJson<JsonValue>(request.path);
  if (value === null) throw new Error(`evidence not found: ${request.path}`);
  return value;
}
