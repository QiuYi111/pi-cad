import { resolveRequestScope, resolveActiveRun, runWithRunScope, type RunScopeRequestV1 } from "../harness/run-scope.ts";
import type { Operation, OperationAuthority } from "../harness/permissions.ts";
import type { JsonValue } from "../harness/canonical.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { handlePartOperation } from "./part-ops.ts";
import { handleTransferOperation } from "./transfer-ops.ts";
import type { AgentApiRequest } from "../authority/protocol.ts";
import { bootstrapAgentApiContracts } from "./bootstrap.ts";
import { requireCurrentAuthorization } from "./authorization.ts";
import { workflowCurrent, workflowAdvance, workflowList, workflowStart, reviewCurrent } from "./workflow-ops.ts";
import { commitHistory, commitWorkspaceOp, evidenceRead, loadCommit } from "./commit-ops.ts";
import { viewerCatalog } from "./viewer-ops.ts";
import { buildAndObserve } from "./model-ops.ts";
import { probeOp } from "./probe-ops.ts";
import { simulationRun } from "./simulation-ops.ts";

/**
 * Every Agent API operation that can mutate an active run is admitted here,
 * before its handler is selected. workflow-start is the sole bootstrap
 * exception because no workflow state exists yet to authorize it.
 */
export const AGENT_API_MUTATION_OPERATIONS = {
  "workflow-advance": "workflow.transition",
  commit: "workspace.commit",
  probe: "probe.run",
  "model-build": "model.build",
  "part-open": "model.build",
  "part-apply": "model.build",
  "part-undo": "model.build",
  "part-try": "probe.run",
  "part-tree": "probe.run",
  "part-query": "probe.run",
  "part-check": "probe.run",
  "part-sweep": "probe.run",
  "part-dfm": "probe.run",
  "simulation-run": "simulation.run",
  "review-submit": "review.submit",
} as const satisfies Partial<Record<AgentApiRequest["op"], Operation>>;

type Op = AgentApiRequest["op"];
type Route<O extends Op> = (cwd: string, request: Extract<AgentApiRequest, { op: O }>) => unknown;

/**
 * Operation → handler. Each resource owns its handlers: workflow-ops (workflow
 * lifecycle and review), commit-ops (workspace commits and evidence), viewer-ops,
 * model-ops, probe-ops, simulation-ops, and the part and transfer modules.
 */
const ROUTES: { [O in Op]?: Route<O> } = {
  "workflow-list": (cwd) => workflowList(cwd),
  "workflow-current": (cwd) => workflowCurrent(cwd),
  "workflow-start": (cwd, request) => workflowStart(cwd, request),
  "workflow-advance": (cwd, request) => workflowAdvance(cwd, request),
  commit: (cwd, request) => commitWorkspaceOp(cwd, request),
  load: (cwd, request) => loadCommit(cwd, request),
  history: (cwd) => commitHistory(cwd),
  "viewer-catalog": (cwd) => viewerCatalog(cwd),
  "evidence-read": (cwd, request) => evidenceRead(cwd, request),
  probe: (cwd, request) => probeOp(cwd, request),
  "model-build": (cwd, request) => buildAndObserve(cwd, request),
  "part-open": (cwd, request) => handlePartOperation(cwd, request),
  "part-apply": (cwd, request) => handlePartOperation(cwd, request),
  "part-undo": (cwd, request) => handlePartOperation(cwd, request),
  "part-try": (cwd, request) => handlePartOperation(cwd, request),
  "part-tree": (cwd, request) => handlePartOperation(cwd, request),
  "part-query": (cwd, request) => handlePartOperation(cwd, request),
  "part-check": (cwd, request) => handlePartOperation(cwd, request),
  "part-sweep": (cwd, request) => handlePartOperation(cwd, request),
  "part-dfm": (cwd, request) => handlePartOperation(cwd, request),
  "transfer-status": (cwd, request) => handleTransferOperation(cwd, request),
  "transfer-features": (cwd, request) => handleTransferOperation(cwd, request),
  "transfer-export": (cwd, request) => handleTransferOperation(cwd, request),
  "simulation-run": (cwd, request) => simulationRun(cwd, request),
  "review-current": (cwd) => reviewCurrent(cwd),
};

/**
 * Conversation-scoped callers (the Prime extension, the cad Python client,
 * or an explicit Agent API runId) enter here; callers that name no
 * conversation keep the legacy project-global pointer.
 */
export async function handleAgentApi(cwd: string, request: AgentApiRequest, authority: OperationAuthority = "author") {
  const scope = request as RunScopeRequestV1;
  if (scope.sessionId !== undefined || scope.runId !== undefined || scope.binding !== undefined) {
    const resolved = await resolveRequestScope(cwd, scope);
    return runWithRunScope(resolved, () => handleScopedAgentApi(cwd, request, authority));
  }
  return handleScopedAgentApi(cwd, request, authority);
}

async function handleScopedAgentApi(cwd: string, request: AgentApiRequest, authority: OperationAuthority = "author") {
  bootstrapAgentApiContracts();
  if (!request || request.schema !== 1 || typeof request.op !== "string") throw new Error("invalid Agent API request");
  const guardedOperation = Object.hasOwn(AGENT_API_MUTATION_OPERATIONS, request.op) ? AGENT_API_MUTATION_OPERATIONS[request.op as keyof typeof AGENT_API_MUTATION_OPERATIONS] : undefined;
  if (guardedOperation) {
    const completedArtifactObservation = request.op === "probe"
      && request.subject !== undefined
      && typeof request.subject !== "string"
      && request.subject.kind === "artifact"
      && typeof request.subject.sha256 === "string"
      && /^[a-f0-9]{64}$/.test(request.subject.sha256)
      && (await resolveActiveRun(cwd, mechanicalRegistries))?.state.status === "done";
    if (!completedArtifactObservation) await requireCurrentAuthorization(cwd, guardedOperation, authority);
  }
  // Own properties only: an op named like an Object.prototype member is unsupported.
  const route = Object.hasOwn(ROUTES, request.op) ? ROUTES[request.op] as ((cwd: string, request: AgentApiRequest) => unknown) : undefined;
  if (!route) throw new Error(`unsupported Agent API operation: ${(request as { op: string }).op}`);
  return await route(cwd, request) as JsonValue;
}
