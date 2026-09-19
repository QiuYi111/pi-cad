import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { completionGate, dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { bindingFromTranscriptEntries, WORKFLOW_BINDING_CUSTOM_TYPE } from "../src/integrations/prime/workflow-binding.ts";

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

async function start(cwd: string, sessionId: string) {
  const response = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-start", id: WORKFLOW_ID, sessionId });
  assert.equal(response.ok, true, response.error?.message);
  return response.result as { runId: string; phase: string; status: string };
}

async function current(cwd: string, sessionId: string) {
  const response = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-current", sessionId });
  assert.equal(response.ok, true, response.error?.message);
  return response.result as null | { runId: string; phase: string; status: string };
}

async function gate(cwd: string, sessionId: string) {
  const response = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "completion-gate", sessionId });
  assert.equal(response.ok, true, response.error?.message);
  return response.result as { complete: boolean; reason: string; runId?: string };
}

async function advance(cwd: string, sessionId: string, event: string) {
  const response = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-advance", event, sessionId });
  assert.equal(response.ok, true, response.error?.message);
  return response.result as { phase: string; status: string };
}

test("each Prime conversation owns its own workflow run", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-conversation-"));
    const project = new HarnessProjectStoreV7(cwd);
    try {
      // A starts Run A. A conversation run never claims the project pointer.
      const runA = await start(cwd, SESSION_A);
      assert.equal(runA.phase, "inspect");
      assert.equal(runA.status, "active");
      assert.equal((await project.load()).state.currentRunId, null);
      assert.deepEqual((await project.load()).state.runs.map((entry) => entry.runId), [runA.runId]);
      assert.equal((await current(cwd, SESSION_A))?.runId, runA.runId);

      // A brand new conversation is unbound: it sees no run, no promoted run,
      // and no phase card from A's work.
      assert.equal(await current(cwd, SESSION_B), null);
      const unboundGate = await gate(cwd, SESSION_B);
      assert.equal(unboundGate.complete, false);
      assert.match(unboundGate.reason, /conversation/);
      assert.equal(unboundGate.runId, undefined);
      const unboundCard = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "phase-card", sessionId: SESSION_B });
      assert.equal(unboundCard.ok, true);
      assert.equal(unboundCard.result, null);

      // B starts its own run; A keeps its own.
      const runB = await start(cwd, SESSION_B);
      assert.notEqual(runB.runId, runA.runId);
      assert.equal((await current(cwd, SESSION_A))?.runId, runA.runId);
      assert.equal((await current(cwd, SESSION_B))?.runId, runB.runId);

      // One conversation's transition does not move another conversation's run.
      assert.deepEqual(await advance(cwd, SESSION_B, "checked"), { phase: "done", status: "done" });
      const untouchedA = await current(cwd, SESSION_A);
      assert.equal(untouchedA?.runId, runA.runId);
      assert.equal(untouchedA?.phase, "inspect");
      assert.equal(untouchedA?.status, "active");
      assert.equal((await gate(cwd, SESSION_B)).complete, true);
      const gateA = await gate(cwd, SESSION_A);
      assert.equal(gateA.complete, false);
      assert.equal(gateA.runId, runA.runId);

      // A reaches its own final state.
      await advance(cwd, SESSION_A, "checked");
      const finishedA = await gate(cwd, SESSION_A);
      assert.equal(finishedA.complete, true);
      assert.equal(finishedA.runId, runA.runId);
      assert.equal((await current(cwd, SESSION_B))?.status, "done");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("a conversation binding survives resume and a promoted run stays invisible to new conversations", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-conversation-resume-"));
    const project = new HarnessProjectStoreV7(cwd);
    try {
      const runA = await start(cwd, SESSION_A);
      await advance(cwd, SESSION_A, "checked");
      const promoted = await project.promoteCompletedRun(runA.runId, mechanicalRegistries);
      assert.equal(promoted.promotedRunId, runA.runId);
      assert.equal(promoted.currentRunId, null);

      // Resume by naming only the session (the Python kernel path): the project
      // conversation registry still resolves Run A.
      assert.equal((await current(cwd, SESSION_A))?.runId, runA.runId);
      // Resume by asserting the transcript binding (the extension path).
      const binding = { schema: 1 as const, sessionId: SESSION_A, runId: runA.runId, workflowHash: (await project.load()).state.runs[0]!.workflowHash, boundAt: new Date().toISOString() };
      const resumed = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-current", sessionId: SESSION_A, binding });
      assert.equal((resumed.result as { runId: string }).runId, runA.runId);

      // An explicit runId works without any session identity at all.
      const explicit = await handleAgentApi(cwd, { schema: 1, op: "workflow-current", runId: runA.runId });
      assert.equal((explicit as { runId: string }).runId, runA.runId);

      // A fresh conversation must not inherit the promoted run.
      assert.equal(await current(cwd, SESSION_C), null);
      const freshGate = await gate(cwd, SESSION_C);
      assert.equal(freshGate.complete, false);
      assert.equal(freshGate.runId, undefined);
      assert.equal(await dispatchSidecarRequest("author", cwd, { schema: 1, op: "phase-card", sessionId: SESSION_C }).then((response) => response.result), null);
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
    try {
      const runA = await start(cwd, SESSION_A);
      const projectScoped = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-start", id: WORKFLOW_ID });
      assert.equal(projectScoped.ok, false);
      assert.match(projectScoped.error?.message ?? "", /project-scoped run/);
      assert.equal((await current(cwd, SESSION_A))?.runId, runA.runId);
      assert.equal((await new HarnessProjectStoreV7(cwd).load()).state.currentRunId, null);
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
