import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalDigest, jsonValue } from "../harness/canonical.ts";
import { loadWorkspaceCommit } from "../harness/commit.ts";
import { currentAuthorization } from "../agent-api/authorization.ts";
import { bootstrapAgentApiContracts } from "../agent-api/bootstrap.ts";
import { handleAgentApi } from "../agent-api/handlers.ts";
import type { AgentApiRequest, AgentApiResponse } from "../agent-api/protocol.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { compilePhaseCard, workflowCurrentView } from "../harness/card.ts";
import { renderAuthorizationDenied, type Operation } from "../harness/permissions.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7, type LoadedHarnessRunV7 } from "../harness/run-store.ts";
import { writeStatusProjection } from "./storage.ts";
import { ReviewRuntime, type ReviewerExecutor } from "./review-runtime.ts";
import { findExperience, getExperience, readExperience, searchExperience } from "../experience/store.ts";
import type { ExperienceSearchOptions } from "../experience/types.ts";

export type SidecarRole = "author" | "reviewer";
type AuthorModelSelection = { provider: string; model: string; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };

export type SidecarRequest = AgentApiRequest
  | { schema: 1; op: "phase-card" }
  | { schema: 1; op: "completion-gate" }
  | { schema: 1; op: "mission-capture"; mission: string }
  | { schema: 1; op: "author-model"; provider: string; model: string; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
  | { schema: 1; op: "review-evidence"; reviewId?: string }
  | { schema: 1; op: "authorize"; operation: Operation }
  | { schema: 1; op: "experience-search"; options?: ExperienceSearchOptions }
  | { schema: 1; op: "experience-get"; identifier: { seq?: number; sha?: string } }
  | { schema: 1; op: "experience-find"; identifier: { seq?: number; sha?: string }; query: string; context?: number; limit?: number }
  | { schema: 1; op: "experience-read"; identifier: { seq?: number; sha?: string }; startLine?: number; endLine?: number };

const MAX_REQUEST_BYTES = 1024 * 1024;
const AUTHOR_ONLY = new Set(["workflow-list", "workflow-start", "workflow-advance", "commit", "model-build", "simulation-run", "review-submit", "review-watch", "phase-card", "completion-gate", "mission-capture", "author-model", "authorize", "experience-search", "experience-get", "experience-find", "experience-read"]);
const COMMON_ALLOWED = new Set(["workflow-current", "load", "probe", "review-current", "history"]);
const REVIEWER_ALLOWED = new Set([...COMMON_ALLOWED, "review-evidence", "review-complete"]);
const READ_ONLY_AUTHOR_DENIED = new Set(["workflow-start", "workflow-advance", "commit", "model-build", "simulation-run", "review-submit", "mission-capture"]);
const READ_ONLY_OPERATIONS = new Set<Operation>(["workspace.commit", "model.build", "simulation.run", "image.generate", "review.submit", "workflow.transition"]);

function errorResponse(error: unknown): AgentApiResponse {
  return {
    schema: 1,
    ok: false,
    error: {
      type: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function validateRequest(value: unknown): asserts value is SidecarRequest {
  if (!value || typeof value !== "object") throw new Error("invalid sidecar protocol request");
  const request = value as { schema?: unknown; op?: unknown };
  if (request.schema !== 1 || typeof request.op !== "string" || !request.op) throw new Error("invalid sidecar protocol request");
}

async function refreshProjection(cwd: string): Promise<void> {
  const project = new HarnessProjectStoreV7(cwd);
  const loadedProject = await project.load();
  const run = loadedProject.state.currentRunId
    ? await new HarnessRunStoreV7(cwd, loadedProject.state.currentRunId).load(mechanicalRegistries)
    : null;
  await writeStatusProjection(cwd, loadedProject.state, run ? {
    state: run.state,
    workflow: run.workflow,
    view: workflowCurrentView(run, mechanicalRegistries),
  } : null);
}

async function refreshProjectionSafely(cwd: string): Promise<void> {
  try { await refreshProjection(cwd); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pi-cad] status projection unavailable: ${message}\n`);
  }
}

function agentExperienceEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...entry };
  delete safe.archive_path;
  delete safe.session_path;
  delete safe.project_path;
  return safe;
}

export async function dispatchSidecarRequest(role: SidecarRole, cwd: string, value: unknown, reviewRuntime?: ReviewRuntime, onAuthorModelSelection?: (selection: AuthorModelSelection) => void, options: { authorReadOnly?: boolean } = {}): Promise<AgentApiResponse> {
  try {
    validateRequest(value);
    if (role === "reviewer" && !REVIEWER_ALLOWED.has(value.op)) {
      throw new Error(`reviewer endpoint does not expose operation: ${value.op}`);
    }
    if (role === "author" && !AUTHOR_ONLY.has(value.op) && !COMMON_ALLOWED.has(value.op)) {
      throw new Error(`author endpoint does not expose operation: ${value.op}`);
    }
    if (role === "author" && options.authorReadOnly && READ_ONLY_AUTHOR_DENIED.has(value.op)) {
      throw new Error(`desktop read-only mode denies operation: ${value.op}; switch permission to Workspace to modify the project`);
    }
    const reviewerRequestId = role === "reviewer" ? (value as { reviewId?: string }).reviewId : undefined;
    if (role === "reviewer") {
      if (!reviewRuntime || !reviewerRequestId) throw new Error("reviewer request is missing its scoped reviewId");
      const subjectCommit = await reviewRuntime.reviewerSubject(reviewerRequestId);
      if (value.op === "load" && value.id !== subjectCommit) throw new Error("reviewer may load only its immutable subject commit");
      if (value.op === "probe") await reviewRuntime.admitProbe(reviewerRequestId);
      if (value.op === "review-complete" && value.reviewId !== reviewerRequestId) throw new Error("reviewer authority does not match review result");
    }
    let result: unknown;
    if (value.op === "author-model") {
      if (role !== "author" || !onAuthorModelSelection) throw new Error("author model reporting is unavailable");
      if (typeof value.provider !== "string" || !value.provider.trim() || typeof value.model !== "string" || !value.model.trim()) throw new Error("author model requires non-empty provider and model");
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking)) throw new Error("author model has an invalid thinking level");
      onAuthorModelSelection({ provider: value.provider.trim(), model: value.model.trim(), thinking: value.thinking });
      result = { recorded: true };
    } else if (value.op === "review-submit") {
      if (!reviewRuntime) throw new Error("review runtime is unavailable");
      const decision = await currentAuthorization(cwd, "review.submit", "author");
      if (!decision?.allowed) throw new Error(decision && !decision.allowed ? renderAuthorizationDenied(decision) : "review.submit requires an active workflow");
      result = await reviewRuntime.submit(value.subjectCommit);
    } else if (value.op === "review-current") {
      result = reviewRuntime ? await reviewRuntime.current(value.reviewId) : await handleAgentApi(cwd, value, role);
    } else if (value.op === "review-evidence") {
      if (role !== "reviewer" || !reviewRuntime || !reviewerRequestId) throw new Error("review evidence requires reviewer authority");
      result = await reviewRuntime.evidence(reviewerRequestId);
    } else if (value.op === "review-complete") {
      if (role !== "reviewer" || !reviewRuntime) throw new Error("review completion requires reviewer authority");
      result = await reviewRuntime.complete(value.reviewId, value.result);
    } else if (value.op === "review-watch") {
      if (role !== "author" || !reviewRuntime) throw new Error("review notification stream is unavailable");
      result = await reviewRuntime.watch(value.after);
    } else if (value.op === "mission-capture") {
      if (role !== "author") throw new Error("mission capture is author-scoped");
      result = await captureMission(cwd, value.mission);
    } else if (value.op === "phase-card") {
      if (role !== "author") throw new Error("phase-card is author-scoped");
      bootstrapAgentApiContracts();
      result = await compilePhaseCard(cwd, { registries: mechanicalRegistries });
    } else if (value.op === "completion-gate") {
      if (role !== "author") throw new Error("completion-gate is author-scoped");
      result = await completionGate(cwd);
    } else if (value.op === "authorize") {
      if (role !== "author") throw new Error("authorization query is author-scoped");
      if (options.authorReadOnly && READ_ONLY_OPERATIONS.has(value.operation)) {
        result = { allowed: false, reason: "Desktop is in read-only mode.", legalNextActions: ["Switch permission to Workspace."] };
      } else {
        const decision = await currentAuthorization(cwd, value.operation, "author");
        result = decision && !decision.allowed ? { ...decision, rendered: renderAuthorizationDenied(decision) } : decision;
      }
    } else if (value.op === "experience-search") {
      result = (await searchExperience(value.options ?? {})).map((entry) => agentExperienceEntry(entry as unknown as Record<string, unknown>));
    } else if (value.op === "experience-get") {
      result = agentExperienceEntry(await getExperience(value.identifier) as unknown as Record<string, unknown>);
    } else if (value.op === "experience-find") {
      result = await findExperience(value.identifier, value.query, value.context, value.limit);
    } else if (value.op === "experience-read") {
      const read = await readExperience(value.identifier, value.startLine, value.endLine);
      result = { ...read, entry: agentExperienceEntry(read.entry as unknown as Record<string, unknown>) };
    } else {
      result = await handleAgentApi(cwd, value, role);
    }
    await refreshProjectionSafely(cwd);
    return { schema: 1, ok: true, result: result as never };
  } catch (error) {
    await refreshProjectionSafely(cwd);
    return errorResponse(error);
  }
}

async function captureMission(cwd: string, requested: string): Promise<{ captured: boolean }> {
  const mission = typeof requested === "string" ? requested.trim() : "";
  if (!mission || Buffer.byteLength(mission) > 32 * 1024) throw new Error("original user request must be between 1 and 32768 bytes");
  const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!active) throw new Error("mission capture requires an active workflow");
  const run = new HarnessRunStoreV7(cwd, active.state.runId);
  const current = await run.transactions.readJson<Record<string, unknown>>("context/frame.json") ?? { schema: 1, fragments: [] };
  if (typeof current.mission === "string" && current.mission.trim()) return { captured: false };
  const now = new Date().toISOString();
  await run.mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, updatedAt: now },
    event: { type: "OriginalUserRequestCaptured", data: { bytes: Buffer.byteLength(mission) } },
    payloads: { "context/frame.json": jsonValue({ ...current, schema: 1, mission, updatedAt: now }) },
  }));
  return { captured: true };
}

async function handleSocket(socket: Socket, role: SidecarRole, cwd: string, reviewRuntime: ReviewRuntime, onAuthorModelSelection?: (selection: AuthorModelSelection) => void, options: { authorReadOnly?: boolean } = {}): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  socket.setTimeout(150_000, () => socket.destroy(new Error("sidecar request timeout")));
  socket.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) socket.destroy(new Error("sidecar request exceeds byte limit"));
    else chunks.push(chunk);
  });
  socket.on("error", () => undefined);
  socket.on("end", async () => {
    let response: AgentApiResponse;
    try {
      const body = Buffer.concat(chunks).toString("utf-8");
      response = await dispatchSidecarRequest(role, cwd, JSON.parse(body), reviewRuntime, onAuthorModelSelection, options);
    } catch (error) {
      response = errorResponse(error);
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await rm(path, { force: true });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      accept();
    });
  });
  await chmod(path, 0o600);
}

export interface AuthoritySidecar {
  authorSocket: string;
  reviewerSocket: string;
  close(): Promise<void>;
}

export async function startAuthoritySidecar(input: { cwd: string; runtimeDirectory: string; reviewerExecutor?: ReviewerExecutor; onAuthorModelSelection?: (selection: AuthorModelSelection) => void; authorReadOnly?: boolean }): Promise<AuthoritySidecar> {
  bootstrapAgentApiContracts();
  const cwd = resolve(input.cwd);
  const authorDirectory = join(resolve(input.runtimeDirectory), "author");
  const reviewerDirectory = join(resolve(input.runtimeDirectory), "reviewer");
  await mkdir(authorDirectory, { recursive: true, mode: 0o700 });
  await mkdir(reviewerDirectory, { recursive: true, mode: 0o700 });
  await chmod(authorDirectory, 0o700);
  await chmod(reviewerDirectory, 0o700);
  const authorSocket = join(authorDirectory, "authority.sock");
  const reviewerSocket = join(reviewerDirectory, "authority.sock");
  const reviewRuntime = new ReviewRuntime(cwd, input.reviewerExecutor ?? (async () => { throw new Error("reviewer executor is not configured"); }));
  const authorServer = createServer({ allowHalfOpen: true }, (socket) => { void handleSocket(socket, "author", cwd, reviewRuntime, input.onAuthorModelSelection, { authorReadOnly: input.authorReadOnly }); });
  const reviewerServer = createServer({ allowHalfOpen: true }, (socket) => { void handleSocket(socket, "reviewer", cwd, reviewRuntime); });
  try {
    await listen(authorServer, authorSocket);
    await listen(reviewerServer, reviewerSocket);
  } catch (error) {
    authorServer.close();
    reviewerServer.close();
    throw error;
  }
  await refreshProjectionSafely(cwd);
  return {
    authorSocket,
    reviewerSocket,
    async close() {
      reviewRuntime.shutdown();
      await Promise.all([authorServer, reviewerServer].map((server) => new Promise<void>((accept) => server.close(() => accept()))));
      await Promise.all([rm(authorSocket, { force: true }), rm(reviewerSocket, { force: true })]);
    },
  };
}

export interface CompletionGateResult {
  complete: boolean;
  reason: string;
  outcome?: "complete" | "clarification_required" | "admitted";
  runId?: string;
  workflowId?: string;
}

async function selectedCompletionRun(cwd: string): Promise<LoadedHarnessRunV7 | null> {
  const { state } = await new HarnessProjectStoreV7(cwd).load();
  const runId = state.currentRunId ?? state.promotedRunId;
  return runId ? new HarnessRunStoreV7(cwd, runId).load(mechanicalRegistries) : null;
}

/** One-shot process success is subordinate to durable workflow completion. */
export async function completionGate(cwd: string): Promise<CompletionGateResult> {
  const loaded = await selectedCompletionRun(cwd);
  if (!loaded) return { complete: false, reason: "no canonical workflow run exists" };
  const phase = loaded.workflow.phases[loaded.state.phase];
  if (loaded.state.interactionMode === "headless" && loaded.state.status === "waiting_user" && loaded.state.phase === "wait_for_user") {
    const review = loaded.state.latestReview;
    if (review?.verdict === "clarification_required"
      && review.profileId === "mechanical.requirements-review"
      && review.workflowHash === loaded.workflow.hash
      && review.registryContractHash === loaded.registryContract.hash) {
      return {
        complete: true,
        outcome: "clarification_required",
        reason: "material requirements ambiguity requires user clarification before CAD begins",
        runId: loaded.state.runId,
        workflowId: loaded.workflow.id,
      };
    }
    const authorOwnedClarification = loaded.workflow.id === "mechanical.benchmark-author-only"
      && loaded.state.records.requirements?.type === "workspace_commit"
      && loaded.state.records.requirements.workflowHash === loaded.workflow.hash
      && loaded.state.phaseHistory.at(-2) === "grilling";
    if (authorOwnedClarification) {
      return {
        complete: true,
        outcome: "clarification_required",
        reason: "author identified a material requirements ambiguity before CAD began",
        runId: loaded.state.runId,
        workflowId: loaded.workflow.id,
      };
    }
    return {
      complete: false,
      reason: "waiting_user is not backed by a current authoritative clarification-required review or author-only benchmark requirements commit",
      runId: loaded.state.runId,
      workflowId: loaded.workflow.id,
    };
  }
  if (!phase?.terminal || loaded.state.status !== "done") {
    return { complete: false, reason: `workflow is ${loaded.state.status} in non-terminal phase ${loaded.state.phase}`, runId: loaded.state.runId, workflowId: loaded.workflow.id };
  }
  if (loaded.workflow.id === "mechanical.benchmark-triage" && loaded.state.phase === "admitted") {
    const review = loaded.state.latestReview;
    const requirements = loaded.state.records.requirements;
    if (review?.verdict === "pass"
      && review.profileId === "mechanical.requirements-review"
      && review.workflowHash === loaded.workflow.hash
      && review.registryContractHash === loaded.registryContract.hash
      && requirements?.type === "workspace_commit"
      && requirements.workflowHash === loaded.workflow.hash) {
      return {
        complete: true,
        outcome: "admitted",
        reason: "requirements contract passed independent review and is ready for a builder",
        runId: loaded.state.runId,
        workflowId: loaded.workflow.id,
      };
    }
    return { complete: false, reason: "admitted requirements are missing current independent PASS authority", runId: loaded.state.runId, workflowId: loaded.workflow.id };
  }
  const release = loaded.state.records.release;
  if (!release || release.type !== "workspace_commit" || release.workflowHash !== loaded.workflow.hash) {
    return { complete: false, reason: "authoritative release commit is missing or stale", runId: loaded.state.runId, workflowId: loaded.workflow.id };
  }
  const finalReleasePhases = new Set(Object.entries(loaded.workflow.phases)
    .filter(([, candidate]) => candidate.recordObligations.some((obligation) => obligation.ref === "release"))
    .filter(([, candidate]) => !candidate.actions.includes("cad_build_step"))
    .map(([phaseId]) => phaseId));
  const requiresFinalReview = Object.entries(loaded.workflow.phases).some(([phaseId, candidate]) => Boolean(candidate.reviewProfile) && (
    (phaseId === loaded.state.phase && Boolean(candidate.terminal))
    ||
    finalReleasePhases.has(phaseId)
    || Object.values(candidate.transitions).some((transition) => finalReleasePhases.has(transition.target) && (transition.reviewVerdicts ?? []).includes("pass"))
  ));
  if (!requiresFinalReview) {
    const releaseManifest = await new HarnessRunStoreV7(cwd, loaded.state.runId).transactions.readJson<{ artifacts?: Array<{ path: string; sha256: string; role: string }> }>(release.path);
    const candidate = loaded.state.artifacts["candidate:authoritative"];
    const source = loaded.state.artifacts["candidate:source"];
    const requiredArtifacts = [candidate, source].filter((item): item is NonNullable<typeof item> => Boolean(item));
    const releaseArtifacts = releaseManifest?.artifacts ?? [];
    if (!candidate || !source || requiredArtifacts.some((required) => !releaseArtifacts.some((item) => item.path === required.path && item.sha256 === required.sha256))) {
      return { complete: false, reason: "release without a final review does not contain the current authoritative candidate and source", runId: loaded.state.runId, workflowId: loaded.workflow.id };
    }
    return { complete: true, outcome: "complete", reason: "terminal workflow and authoritative release commit are valid without a final review", runId: loaded.state.runId, workflowId: loaded.workflow.id };
  }
  const review = loaded.state.latestReview;
  let releaseMatchesReview = review?.subjectHash === release.sha256;
  if (review?.artifactHash && review.subjectCommit) {
    const releaseManifest = await new HarnessRunStoreV7(cwd, loaded.state.runId).transactions.readJson<{ parent?: string | null; artifacts?: Array<{ path: string; sha256: string; role: string }> }>(release.path);
    const reviewedManifest = await loadWorkspaceCommit(cwd, mechanicalRegistries, review.subjectCommit);
    releaseMatchesReview = releaseManifest?.parent === review.subjectCommit
      && Boolean(releaseManifest.artifacts)
      && canonicalArtifactContentHash(releaseManifest.artifacts!) === canonicalArtifactContentHash(reviewedManifest.manifest.artifacts);
  }
  if (!review || review.verdict.toLowerCase() !== "pass" || review.workflowHash !== loaded.workflow.hash
    || review.registryContractHash !== loaded.registryContract.hash || !releaseMatchesReview) {
    return { complete: false, reason: "required final review authority is missing, stale, not PASS, or bound to another release", runId: loaded.state.runId, workflowId: loaded.workflow.id };
  }
  return { complete: true, outcome: "complete", reason: "terminal workflow, final PASS, and release commit are valid", runId: loaded.state.runId, workflowId: loaded.workflow.id };
}

function canonicalArtifactContentHash(artifacts: Array<{ path: string; sha256: string }>): string {
  return canonicalDigest(artifacts.map(({ path, sha256 }) => ({ path, sha256 })));
}
