import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { completionGate, completionGateForConversation, dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { bindingFromTranscriptEntries, WORKFLOW_BINDING_CUSTOM_TYPE, type ConversationBindingV1 } from "../src/integrations/prime/workflow-binding.ts";

const SESSION_A = "prime-session-a";
const SESSION_B = "prime-session-b";
const SESSION_C = "prime-session-c";
const WORKFLOW_ID = "test/conversation-lifecycle";

/** One inspection phase that only needs an acknowledged transition. */
const WORKFLOW_PACKAGE = `schema: 1
id: ${WORKFLOW_ID}
description: Conversation lifecycle fixture with one inspection phase.
tags: [test]
version: 1.0.0
workflow:
  schema: 1
  id: ${WORKFLOW_ID}
  version: 1.0.0
  parametersSchema: {type: object, additionalProperties: false}
  initialPhase: inspect
  phases:
    inspect:
      purpose: Acknowledge inspection.
      actions: [transition]
      grants: [file_read, transition]
      writeScopes: []
      recordObligations: []
      evidenceObligations: []
      contextProviders: [kernel.current-action]
      hooks: []
      transitions: {checked: {target: done}}
    done:
      purpose: Preserve the acknowledged inspection.
      actions: []
      grants: [file_read]
      writeScopes: []
      recordObligations: []
      evidenceObligations: []
      contextProviders: []
      hooks: []
      transitions: {}
      terminal: true
`;

/** Install the fixture package for the duration of one test. */
async function withWorkflowPackage<T>(body: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "pi-cad-conversation-workflows-"));
  const previous = process.env.PI_CAD_WORKFLOW_HOME;
  const workflows = join(home, ".pi-cad", "workflows");
  await mkdir(workflows, { recursive: true });
  await writeFile(join(workflows, "conversation-lifecycle.yaml"), WORKFLOW_PACKAGE);
  process.env.PI_CAD_WORKFLOW_HOME = home;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_WORKFLOW_HOME;
    else process.env.PI_CAD_WORKFLOW_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

type RunRequest = Record<string, unknown>;

interface PrimeConversation {
  sessionId: string;
  binding: ConversationBindingV1 | null;
  /** The request fields the Prime extension sends for this conversation. */
  scope(): RunRequest;
  /** The transcript entry the extension appends once it learns its run. */
  persist(runId: string): void;
}

/**
 * Stand-in for the Prime extension. It reads its conversation's transcript
 * once and afterwards always states what that transcript holds: the binding it
 * persisted, or an explicit `binding: null` plus the time it read.
 */
function primeConversation(sessionId: string, readAt = new Date(Date.now() - 1_000).toISOString()): PrimeConversation {
  const conversation: PrimeConversation = {
    sessionId,
    binding: null,
    // A run this conversation starts later is newer than this read, so the
    // comparison never depends on clock resolution.
    scope: () => ({
      sessionId,
      binding: conversation.binding,
      ...(conversation.binding ? {} : { bindingReadAt: readAt }),
    }),
    persist: (runId) => {
      conversation.binding = { schema: 1, sessionId, runId, workflowHash: "b".repeat(64), boundAt: new Date().toISOString() };
    },
  };
  return conversation;
}

/** The stateless cad Python kernel: it names its session but reads no transcript. */
function kernelScope(sessionId: string): RunRequest {
  return { sessionId };
}

async function send(cwd: string, request: RunRequest) {
  const response = await dispatchSidecarRequest("author", cwd, { schema: 1, ...request });
  assert.equal(response.ok, true, response.error?.message);
  return response.result;
}

async function start(cwd: string, scope: RunRequest) {
  return await send(cwd, { op: "workflow-start", id: WORKFLOW_ID, ...scope }) as { runId: string; phase: string; status: string };
}

async function current(cwd: string, scope: RunRequest) {
  return await send(cwd, { op: "workflow-current", ...scope }) as null | { runId: string; phase: string; status: string };
}

async function gate(cwd: string, scope: RunRequest) {
  return await send(cwd, { op: "completion-gate", ...scope }) as { complete: boolean; reason: string; runId?: string };
}

async function card(cwd: string, scope: RunRequest) {
  return await send(cwd, { op: "phase-card", ...scope }) as null | { runId: string; phase: string };
}

async function advance(cwd: string, scope: RunRequest, event: string) {
  return await send(cwd, { op: "workflow-advance", event, ...scope }) as { phase: string; status: string };
}

test("each Prime conversation owns its own workflow run", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-conversation-"));
    const project = new HarnessProjectStoreV7(cwd);
    const a = primeConversation(SESSION_A);
    const b = primeConversation(SESSION_B);
    try {
      // A conversation that has started nothing is unbound, not project-scoped.
      assert.equal(await current(cwd, a.scope()), null);

      // A starts Run A. A conversation run never claims the project pointer.
      const runA = await start(cwd, a.scope());
      assert.equal(runA.phase, "inspect");
      assert.equal(runA.status, "active");
      assert.equal((await project.load()).state.currentRunId, null);
      assert.deepEqual((await project.load()).state.runs.map((entry) => entry.runId), [runA.runId]);
      // The extension persists the run its conversation just started.
      a.persist(runA.runId);
      assert.equal((await current(cwd, a.scope()))?.runId, runA.runId);
      assert.equal((await completionGate(cwd)).complete, false, "project-level gate must not inherit a conversation run");
      const gateA = await completionGateForConversation(cwd, SESSION_A);
      assert.equal(gateA.complete, false);
      assert.equal(gateA.runId, runA.runId, "one-shot launcher can check its root conversation explicitly");

      // A brand new conversation is unbound: it sees no run, no promoted run,
      // and no phase card from A's work.
      assert.equal(await current(cwd, b.scope()), null);
      const unboundGate = await gate(cwd, b.scope());
      assert.equal(unboundGate.complete, false);
      assert.match(unboundGate.reason, /conversation/);
      assert.equal(unboundGate.runId, undefined);
      assert.equal(await card(cwd, b.scope()), null);

      // B starts its own run; A keeps its own.
      const runB = await start(cwd, b.scope());
      b.persist(runB.runId);
      assert.notEqual(runB.runId, runA.runId);
      assert.equal((await current(cwd, a.scope()))?.runId, runA.runId);
      assert.equal((await current(cwd, b.scope()))?.runId, runB.runId);

      // One conversation's transition does not move another conversation's run.
      assert.deepEqual(await advance(cwd, b.scope(), "checked"), { phase: "done", status: "done" });
      const untouchedA = await current(cwd, a.scope());
      assert.equal(untouchedA?.runId, runA.runId);
      assert.equal(untouchedA?.phase, "inspect");
      assert.equal(untouchedA?.status, "active");
      assert.equal((await gate(cwd, b.scope())).complete, true);
      const gateAAfterB = await gate(cwd, a.scope());
      assert.equal(gateAAfterB.complete, false);
      assert.equal(gateAAfterB.runId, runA.runId);

      // A reaches its own final state.
      await advance(cwd, a.scope(), "checked");
      const finishedA = await gate(cwd, a.scope());
      assert.equal(finishedA.complete, true);
      assert.equal(finishedA.runId, runA.runId);
      assert.equal((await current(cwd, b.scope()))?.status, "done");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("a conversation binding survives resume and a promoted run stays invisible to new conversations", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-conversation-resume-"));
    const project = new HarnessProjectStoreV7(cwd);
    const a = primeConversation(SESSION_A);
    try {
      const runA = await start(cwd, a.scope());
      a.persist(runA.runId);
      await advance(cwd, a.scope(), "checked");
      const promoted = await project.promoteCompletedRun(runA.runId, mechanicalRegistries);
      assert.equal(promoted.promotedRunId, runA.runId);
      assert.equal(promoted.currentRunId, null);

      // Resume by naming only the session (the Python kernel path): the project
      // conversation registry still resolves Run A.
      assert.equal((await current(cwd, kernelScope(SESSION_A)))?.runId, runA.runId);
      // Resume by asserting the transcript binding (the extension path).
      const binding = { schema: 1 as const, sessionId: SESSION_A, runId: runA.runId, workflowHash: (await project.load()).state.runs[0]!.workflowHash, boundAt: new Date().toISOString() };
      const resumed = await send(cwd, { op: "workflow-current", sessionId: SESSION_A, binding });
      assert.equal((resumed as { runId: string }).runId, runA.runId);

      // An explicit runId works without any session identity at all.
      const explicit = await handleAgentApi(cwd, { schema: 1, op: "workflow-current", runId: runA.runId });
      assert.equal((explicit as { runId: string }).runId, runA.runId);

      // A fresh conversation must not inherit the promoted run.
      const fresh = primeConversation(SESSION_C);
      assert.equal(await current(cwd, fresh.scope()), null);
      const freshGate = await gate(cwd, fresh.scope());
      assert.equal(freshGate.complete, false);
      assert.equal(freshGate.runId, undefined);
      assert.equal(await card(cwd, fresh.scope()), null);
      // The project pointer keeps its old meaning for callers that name no conversation.
      assert.equal((await completionGate(cwd)).complete, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("a project-scoped run cannot start behind an active conversation run", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-conversation-guard-"));
    const a = primeConversation(SESSION_A);
    try {
      const runA = await start(cwd, a.scope());
      const projectScoped = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-start", id: WORKFLOW_ID });
      assert.equal(projectScoped.ok, false);
      assert.match(projectScoped.error?.message ?? "", /project-scoped run/);
      a.persist(runA.runId);
      assert.equal((await current(cwd, a.scope()))?.runId, runA.runId);
      assert.equal((await new HarnessProjectStoreV7(cwd).load()).state.currentRunId, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("an explicit unbound declaration never revives a historical run", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-conversation-stale-"));
    const project = new HarnessProjectStoreV7(cwd);
    try {
      // This conversation's kernel started Run A, so the project registry caches
      // the session to run binding.
      const runA = await start(cwd, kernelScope(SESSION_A));
      const stored = await project.conversationBinding(SESSION_A);
      assert.equal(stored?.runId, runA.runId);

      // A Prime transcript read without a binding is unbound: current state,
      // completion gate and phase card never fall back to that cached run.
      assert.equal(await current(cwd, { sessionId: SESSION_A, binding: null }), null);
      const staleGate = await gate(cwd, { sessionId: SESSION_A, binding: null });
      assert.equal(staleGate.complete, false);
      assert.match(staleGate.reason, /conversation/);
      assert.equal(staleGate.runId, undefined);
      assert.equal(await card(cwd, { sessionId: SESSION_A, binding: null }), null);

      // A transcript read after the run was bound is history, not this run.
      const readAfter = primeConversation(SESSION_A, new Date(Date.parse(stored!.boundAt) + 1_000).toISOString());
      assert.equal(await current(cwd, readAfter.scope()), null);
      assert.equal(await card(cwd, readAfter.scope()), null);

      // A malformed declaration is unbound as well, never a registry lookup.
      assert.equal(await current(cwd, { sessionId: SESSION_A, binding: { schema: 1, sessionId: SESSION_A, runId: "../escape" } }), null);

      // A conversation that read its transcript before it started Run B adopts
      // only that newer run; the stateless kernel keeps naming its own run too.
      const runB = await start(cwd, kernelScope(SESSION_B));
      const boundB = await project.conversationBinding(SESSION_B);
      const readBefore = primeConversation(SESSION_B, new Date(Date.parse(boundB!.boundAt) - 1_000).toISOString());
      assert.equal((await current(cwd, readBefore.scope()))?.runId, runB.runId);
      assert.equal((await current(cwd, kernelScope(SESSION_A)))?.runId, runA.runId);
      assert.equal((await gate(cwd, kernelScope(SESSION_A))).runId, runA.runId);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("transcript bindings are read per conversation and never guessed", () => {
  const binding = { schema: 1, sessionId: SESSION_A, runId: "v7-1-abcdefgh", workflowHash: "a".repeat(64), boundAt: "2026-09-19T00:00:00.000Z" };
  const entries = [
    { type: "message", role: "user", content: "design a bracket" },
    { type: "custom", customType: WORKFLOW_BINDING_CUSTOM_TYPE, data: binding },
  ];
  assert.deepEqual(bindingFromTranscriptEntries(entries, SESSION_A), binding);
  // Another conversation's binding is invisible, and so is a malformed one.
  assert.equal(bindingFromTranscriptEntries(entries, SESSION_B), null);
  assert.equal(bindingFromTranscriptEntries([{ type: "custom", customType: WORKFLOW_BINDING_CUSTOM_TYPE, data: { ...binding, runId: "../escape" } }], SESSION_A), null);
  assert.equal(bindingFromTranscriptEntries([{ type: "custom", customType: "pi-cad.review-completed", data: binding }], SESSION_A), null);
  // Append-only transcripts: the newest binding wins.
  const newer = { ...binding, runId: "v7-2-abcdefgh", boundAt: "2026-09-19T01:00:00.000Z" };
  assert.deepEqual(bindingFromTranscriptEntries([...entries, { type: "custom", customType: WORKFLOW_BINDING_CUSTOM_TYPE, data: newer }], SESSION_A), newer);
});
