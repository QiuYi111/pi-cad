import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalDigest } from "../harness/canonical.ts";
import { currentAuthorization } from "../agent-api/authorization.ts";
import { bootstrapAgentApiContracts } from "../agent-api/bootstrap.ts";
import { handleAgentApi } from "../agent-api/handlers.ts";
import type { AgentApiRequest, AgentApiResponse } from "../agent-api/protocol.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { compilePhaseCard } from "../harness/card.ts";
import { renderAuthorizationDenied, type Operation } from "../harness/permissions.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7, type LoadedHarnessRunV7 } from "../harness/run-store.ts";
import { writeStatusProjection } from "./storage.ts";
import { ReviewRuntime, type ReviewerExecutor } from "./review-runtime.ts";

export type SidecarRole = "author" | "reviewer";

export type SidecarRequest = AgentApiRequest
  | { schema: 1; op: "phase-card" }
  | { schema: 1; op: "authorize"; operation: Operation };

const MAX_REQUEST_BYTES = 1024 * 1024;
const AUTHOR_ONLY = new Set(["workflow-list", "workflow-start", "workflow-advance", "commit", "model-build", "simulation-run", "review-submit", "review-watch", "phase-card", "authorize"]);
const COMMON_ALLOWED = new Set(["workflow-current", "load", "probe", "review-current", "history"]);
const REVIEWER_ALLOWED = new Set([...COMMON_ALLOWED, "review-complete"]);

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
  await writeStatusProjection(cwd, loadedProject.state, run?.state ?? null);
}

async function refreshProjectionSafely(cwd: string): Promise<void> {
  try { await refreshProjection(cwd); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pi-cad] status projection unavailable: ${message}\n`);
  }
}

export async function dispatchSidecarRequest(role: SidecarRole, cwd: string, value: unknown, reviewRuntime?: ReviewRuntime): Promise<AgentApiResponse> {
  try {
    validateRequest(value);
    if (role === "reviewer" && !REVIEWER_ALLOWED.has(value.op)) {
      throw new Error(`reviewer endpoint does not expose operation: ${value.op}`);
    }
    if (role === "author" && !AUTHOR_ONLY.has(value.op) && !COMMON_ALLOWED.has(value.op)) {
      throw new Error(`author endpoint does not expose operation: ${value.op}`);
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
    if (value.op === "review-submit") {
      if (!reviewRuntime) throw new Error("review runtime is unavailable");
      const decision = await currentAuthorization(cwd, "review.submit", "author");
      if (!decision?.allowed) throw new Error(decision && !decision.allowed ? renderAuthorizationDenied(decision) : "review.submit requires an active workflow");
      result = await reviewRuntime.submit(value.subjectCommit);
    } else if (value.op === "review-current") {
      result = reviewRuntime ? await reviewRuntime.current(value.reviewId) : await handleAgentApi(cwd, value, role);
    } else if (value.op === "review-complete") {
      if (role !== "reviewer" || !reviewRuntime) throw new Error("review completion requires reviewer authority");
      result = await reviewRuntime.complete(value.reviewId, value.result);
    } else if (value.op === "review-watch") {
      if (role !== "author" || !reviewRuntime) throw new Error("review notification stream is unavailable");
      result = await reviewRuntime.watch(value.after);
    } else if (value.op === "phase-card") {
      if (role !== "author") throw new Error("phase-card is author-scoped");
      bootstrapAgentApiContracts();
      result = await compilePhaseCard(cwd, { registries: mechanicalRegistries });
    } else if (value.op === "authorize") {
      if (role !== "author") throw new Error("authorization query is author-scoped");
      const decision = await currentAuthorization(cwd, value.operation, "author");
      result = decision && !decision.allowed ? { ...decision, rendered: renderAuthorizationDenied(decision) } : decision;
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

async function handleSocket(socket: Socket, role: SidecarRole, cwd: string, reviewRuntime: ReviewRuntime): Promise<void> {
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
      response = await dispatchSidecarRequest(role, cwd, JSON.parse(body), reviewRuntime);
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

export async function startAuthoritySidecar(input: { cwd: string; runtimeDirectory: string; reviewerExecutor?: ReviewerExecutor }): Promise<AuthoritySidecar> {
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
  const authorServer = createServer({ allowHalfOpen: true }, (socket) => { void handleSocket(socket, "author", cwd, reviewRuntime); });
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
  runId?: string;
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
  if (!phase?.terminal || loaded.state.status !== "done") {
    return { complete: false, reason: `workflow is ${loaded.state.status} in non-terminal phase ${loaded.state.phase}`, runId: loaded.state.runId };
  }
  const release = loaded.state.records.release;
  if (!release || release.type !== "workspace_commit" || release.workflowHash !== loaded.workflow.hash) {
    return { complete: false, reason: "authoritative release commit is missing or stale", runId: loaded.state.runId };
  }
  const review = loaded.state.latestReview;
  let releaseMatchesReview = review?.subjectHash === release.sha256;
  if (review?.artifactHash) {
    const manifest = await new HarnessRunStoreV7(cwd, loaded.state.runId).transactions.readJson<{ artifacts?: Array<{ path: string; sha256: string; role: string }> }>(release.path);
    releaseMatchesReview = Boolean(manifest?.artifacts) && canonicalArtifactHash(manifest!.artifacts!) === review.artifactHash;
  }
  if (!review || review.verdict.toLowerCase() !== "pass" || review.workflowHash !== loaded.workflow.hash
    || review.registryContractHash !== loaded.registryContract.hash || !releaseMatchesReview) {
    return { complete: false, reason: "required final review authority is missing, stale, not PASS, or bound to another release", runId: loaded.state.runId };
  }
  return { complete: true, reason: "terminal workflow, final PASS, and release commit are valid", runId: loaded.state.runId };
}

function canonicalArtifactHash(artifacts: Array<{ path: string; sha256: string; role: string }>): string {
  return canonicalDigest(artifacts.map(({ path, sha256, role }) => ({ path, sha256, role })));
}
