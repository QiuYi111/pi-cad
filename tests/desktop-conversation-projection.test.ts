import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";

const WORKFLOW_ID = "test/desktop-conversation";
const SESSION_A = "desktop-conversation-a";
const SESSION_B = "desktop-conversation-b";
const SESSION_UNUSED = "desktop-conversation-unused";

/** One inspection phase that only needs an acknowledged transition. */
const WORKFLOW_PACKAGE = `schema: 1
id: ${WORKFLOW_ID}
description: Desktop conversation fixture with one inspection phase.
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
      actions: [transition, cad_commit]
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

async function withWorkflowPackage<T>(body: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "pi-cad-desktop-conversation-workflows-"));
  const previous = process.env.PI_CAD_WORKFLOW_HOME;
  const workflows = join(home, ".pi-cad", "workflows");
  await mkdir(workflows, { recursive: true });
  await writeFile(join(workflows, "desktop-conversation.yaml"), WORKFLOW_PACKAGE);
  process.env.PI_CAD_WORKFLOW_HOME = home;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_WORKFLOW_HOME;
    else process.env.PI_CAD_WORKFLOW_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * How the Desktop talks to the authority: it names the Prime session it shows
 * and nothing else. A Desktop process cannot read a transcript, so an explicit
 * `binding` declaration is not available to it; the conversation registry the
 * authority keeps is what resolves the conversation's own run.
 */
async function desktopRequest(cwd: string, sessionId: string, op: string, extra: Record<string, unknown> = {}) {
  return await handleAgentApi(cwd, { schema: 1, op, sessionId, ...extra } as never);
}

/**
 * The Desktop window Prime has not opened a session for yet: the click on "new
 * conversation" before its first prompt. It is a conversation window with no
 * session, so the authority answers it as unbound — which is not the same as
 * the stateless caller that names no conversation at all.
 */
async function desktopWindowRequest(cwd: string, op: string, extra: Record<string, unknown> = {}) {
  return await handleAgentApi(cwd, { schema: 1, op, sessionId: null, ...extra } as never);
}

async function startConversationRun(cwd: string, sessionId: string) {
  return await desktopRequest(cwd, sessionId, "workflow-start", { id: WORKFLOW_ID }) as { runId: string; phase: string; status: string };
}

async function desktopCurrent(cwd: string, sessionId: string) {
  return await desktopRequest(cwd, sessionId, "workflow-current") as null | {
    runId: string;
    phase: string;
    status: string;
    updatedAt: string;
    phaseHistory: string[];
    phases: Array<{ id: string; status: string }>;
  };
}

/** The rail renders phases in workflow order; compare them as a picture. */
function phaseStatuses(current: { phases: Array<{ id: string; status: string }> } | null) {
  return [...(current?.phases ?? [])].sort((left, right) => left.id.localeCompare(right.id)).map((phase) => [phase.id, phase.status]);
}

test("the Desktop projects the workflow of the conversation it selected", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-desktop-conversation-"));
    try {
      // Conversation A runs to its final state.
      const runA = await startConversationRun(cwd, SESSION_A);
      await desktopRequest(cwd, SESSION_A, "workflow-advance", { event: "checked" });
      const finalA = await desktopCurrent(cwd, SESSION_A);
      assert.equal(finalA?.runId, runA.runId);
      assert.equal(finalA?.status, "done");
      assert.deepEqual(finalA?.phaseHistory, ["inspect", "done"]);
      assert.deepEqual(phaseStatuses(finalA), [["done", "complete"], ["inspect", "complete"]]);
      assert.ok(finalA?.updatedAt, "the rail needs the run's own update time");

      // A conversation that has started nothing is unbound: no run, no other
      // conversation's final state.
      assert.equal(await desktopCurrent(cwd, SESSION_B), null);
      const unboundCatalog = await desktopRequest(cwd, SESSION_B, "viewer-catalog") as { currentRun: unknown; projectId: string };
      assert.equal(unboundCatalog.currentRun, null);
      assert.ok(unboundCatalog.projectId, "the project itself stays visible to an unbound conversation");

      // Conversation B starts its own run and stays in a non-terminal phase.
      const runB = await startConversationRun(cwd, SESSION_B);
      assert.notEqual(runB.runId, runA.runId);
      const liveB = await desktopCurrent(cwd, SESSION_B);
      assert.equal(liveB?.runId, runB.runId);
      assert.equal(liveB?.status, "active");
      assert.equal(liveB?.phase, "inspect");
      assert.deepEqual(phaseStatuses(liveB), [["done", "pending"], ["inspect", "active"]]);

      // Switching back and forth never changes the other conversation's run.
      assert.equal((await desktopCurrent(cwd, SESSION_A))?.runId, runA.runId);
      assert.equal((await desktopCurrent(cwd, SESSION_A))?.status, "done");
      assert.equal((await desktopCurrent(cwd, SESSION_B))?.runId, runB.runId);
      assert.equal((await desktopCurrent(cwd, SESSION_B))?.status, "active");

      // The viewer follows the same conversation: each one sees its own run.
      const catalogA = await desktopRequest(cwd, SESSION_A, "viewer-catalog") as { currentRun: null | { id: string; status: string } };
      const catalogB = await desktopRequest(cwd, SESSION_B, "viewer-catalog") as { currentRun: null | { id: string; status: string } };
      assert.equal(catalogA.currentRun?.id, runA.runId);
      assert.equal(catalogA.currentRun?.status, "done");
      assert.equal(catalogB.currentRun?.id, runB.runId);
      assert.equal(catalogB.currentRun?.status, "active");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("a Desktop conversation never inherits a promoted or project-level run", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-desktop-promoted-"));
    const project = new HarnessProjectStoreV7(cwd);
    try {
      const runA = await startConversationRun(cwd, SESSION_A);
      await desktopRequest(cwd, SESSION_A, "workflow-advance", { event: "checked" });
      await project.promoteCompletedRun(runA.runId, mechanicalRegistries);
      assert.equal((await project.load()).state.currentRunId, null);
      assert.equal((await project.load()).state.promotedRunId, runA.runId);

      // A conversation the authority never bound stays unbound even though the
      // project remembers a finished run.
      assert.equal(await desktopCurrent(cwd, SESSION_UNUSED), null);
      const catalog = await desktopRequest(cwd, SESSION_UNUSED, "viewer-catalog") as { currentRun: unknown };
      assert.equal(catalog.currentRun, null);

      // The project-global pointer keeps its legacy meaning for callers that
      // name no conversation at all.
      const projectScoped = await handleAgentApi(cwd, { schema: 1, op: "viewer-catalog" }) as { currentRun: { id: string } | null };
      assert.equal(projectScoped.currentRun?.id ?? null, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("a Desktop window with no Prime session reads no run, commit or artifact", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-desktop-unbound-window-"));
    try {
      // A headless caller (the CLI, a benchmark) leaves the project-global
      // pointer on its own run. That pointer is what the Desktop used to read
      // whenever it named no conversation.
      const projectRun = await handleAgentApi(cwd, {
        schema: 1, op: "workflow-start", id: WORKFLOW_ID, interactionMode: "headless",
      }) as { runId: string };
      // Conversation A owns a run with a recorded artifact and reaches final.
      const runA = await startConversationRun(cwd, SESSION_A);
      await desktopRequest(cwd, SESSION_A, "commit", { name: "design-freeze" });
      await desktopRequest(cwd, SESSION_A, "workflow-advance", { event: "checked" });

      // The window right after "new conversation": conversation-scoped, no
      // session, so neither A's run nor the project's run is on screen.
      const unbound = await desktopWindowRequest(cwd, "viewer-catalog") as {
        projectId: string;
        currentRun: unknown;
        commits: unknown[];
        parameterManifests: unknown[];
      };
      assert.equal(unbound.currentRun, null);
      assert.deepEqual(unbound.commits, []);
      assert.deepEqual(unbound.parameterManifests, []);
      assert.ok(unbound.projectId, "project HEAD stays visible to every conversation");
      assert.equal(await desktopWindowRequest(cwd, "workflow-current"), null);

      // A conversation still reads its own run, commit and artifact.
      const finalA = await desktopCurrent(cwd, SESSION_A);
      assert.equal(finalA?.runId, runA.runId);
      assert.equal(finalA?.status, "done");
      const catalogA = await desktopRequest(cwd, SESSION_A, "viewer-catalog") as { currentRun: { id: string }; commits: unknown[] };
      assert.equal(catalogA.currentRun.id, runA.runId);
      assert.equal(catalogA.commits.length, 1);

      // Naming no conversation at all keeps its legacy meaning: only a
      // headless caller reads the project-global run that way.
      const legacy = await handleAgentApi(cwd, { schema: 1, op: "viewer-catalog" }) as { currentRun: { id: string } | null };
      assert.equal(legacy.currentRun?.id, projectRun.runId);

      // A window with no session cannot start a run nothing would own, and the
      // refusal leaves the project run exactly where it was.
      await assert.rejects(desktopWindowRequest(cwd, "workflow-start", { id: WORKFLOW_ID }), /conversation/);
      const projectCurrent = await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as { runId: string };
      assert.equal(projectCurrent.runId, projectRun.runId);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("a parameter run in one conversation neither reads nor changes another conversation's run", async () => {
  await withWorkflowPackage(async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-cad-desktop-parameter-scope-"));
    try {
      // Conversation A owns a finished run with a recorded artifact.
      const runA = await startConversationRun(cwd, SESSION_A);
      await desktopRequest(cwd, SESSION_A, "commit", { name: "release-candidate" });
      await desktopRequest(cwd, SESSION_A, "workflow-advance", { event: "checked" });

      // A conversation B parameter change asks for B's own run first. B has
      // none, so it starts B's own run: never the project pointer, never A.
      assert.equal(await desktopCurrent(cwd, SESSION_B), null);
      const runB = await startConversationRun(cwd, SESSION_B);
      assert.notEqual(runB.runId, runA.runId);

      // A is untouched, including its commit and its final phase history.
      const finalA = await desktopCurrent(cwd, SESSION_A);
      assert.equal(finalA?.runId, runA.runId);
      assert.equal(finalA?.status, "done");
      assert.deepEqual(finalA?.phaseHistory, ["inspect", "done"]);
      const catalogA = await desktopRequest(cwd, SESSION_A, "viewer-catalog") as { currentRun: { id: string; status: string }; commits: unknown[] };
      assert.equal(catalogA.currentRun.id, runA.runId);
      assert.equal(catalogA.currentRun.status, "done");
      assert.equal(catalogA.commits.length, 1);

      // B's run is B's own: its own catalog, none of A's commits, and the
      // conversation registry binds it to B without touching the project.
      const catalogB = await desktopRequest(cwd, SESSION_B, "viewer-catalog") as { currentRun: { id: string; status: string }; commits: unknown[] };
      assert.equal(catalogB.currentRun.id, runB.runId);
      assert.equal(catalogB.currentRun.status, "active");
      assert.deepEqual(catalogB.commits, []);
      const project = new HarnessProjectStoreV7(cwd);
      assert.equal((await project.conversationBinding(SESSION_B))?.runId, runB.runId);
      assert.equal((await project.load()).state.currentRunId, null, "a conversation run never touches the project pointer");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
