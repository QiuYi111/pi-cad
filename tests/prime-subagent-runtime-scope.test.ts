import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { startAuthoritySidecar, dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import primeExtension from "../src/integrations/prime/extension.ts";
import { WORKFLOW_BINDING_CUSTOM_TYPE } from "../src/integrations/prime/workflow-binding.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

const PARENT_SESSION = "prime-parent-session";
const CHILD_SESSION = "prime-child-session";
const GRANDCHILD_SESSION = "prime-grandchild-session";

/** One inspection phase with no obligations, so a run reaches done with one event. */
function workflow() {
  return compileWorkflowDefinition({
    schema: 1,
    id: "test/prime-subagent-scope",
    version: "1.0.0",
    parametersSchema: {},
    initialPhase: "inspect",
    phases: {
      inspect: {
        purpose: "Acknowledge inspection.",
        actions: ["transition"],
        grants: ["file_read", "transition"],
        writeScopes: [],
        recordObligations: [],
        evidenceObligations: [],
        contextProviders: ["kernel.current-action"],
        hooks: [],
        transitions: { checked: { target: "done" } },
      },
      done: {
        purpose: "Preserve the acknowledged inspection.",
        actions: [],
        grants: ["file_read"],
        writeScopes: [],
        recordObligations: [],
        evidenceObligations: [],
        contextProviders: [],
        hooks: [],
        transitions: {},
        terminal: true,
      },
    },
  }, mechanicalRegistries);
}

interface RecordedEntry {
  customType: string;
  data: any;
}

/**
 * The Prime host side of one process: one loaded extension instance, which a
 * parent and its children all call through. The extension must keep each
 * conversation's state where that conversation can reach it.
 */
function primeProcess() {
  const handlers = new Map<string, Function>();
  const appendedEntries: RecordedEntry[] = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool() {},
    getThinkingLevel() { return "low"; },
    sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
    appendEntry(customType: string, data: unknown) { appendedEntries.push({ customType, data }); },
  } as any;
  primeExtension(pi);
  return { handlers, appendedEntries, sentMessages };
}

/** One Prime conversation: its own session identity and its own transcript. */
function conversation(cwd: string, sessionId: string) {
  const entries: any[] = [];
  return {
    ctx: {
      cwd,
      model: { provider: "faux", id: "faux" },
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
        getBranch: () => entries,
      },
    },
    entries,
  };
}

function bindingOf(entry: RecordedEntry | undefined) {
  assert.ok(entry, "expected a persisted workflow binding");
  assert.equal(entry!.customType, WORKFLOW_BINDING_CUSTOM_TYPE);
  const data = entry!.data as Record<string, unknown>;
  return { sessionId: data.sessionId as string, runId: data.runId as string };
}

test("a parent, child and grandchild each resolve their own workflow run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-subagent-scope-"));
  const runtime = await mkdtemp(join(tmpdir(), "pi-cad-subagent-scope-sidecar-"));
  const previousSocket = process.env.PI_CAD_AUTHOR_SOCKET;
  const previousSessionId = process.env.PI_CAD_SESSION_ID;
  const sidecar = await startAuthoritySidecar({ cwd, runtimeDirectory: runtime });
  process.env.PI_CAD_AUTHOR_SOCKET = sidecar.authorSocket;
  delete process.env.PI_CAD_SESSION_ID;

  const { handlers, appendedEntries } = primeProcess();
  const beforeAgentStart = handlers.get("before_agent_start")!;
  const beforeRefine = handlers.get("session_before_refine")!;
  const parent = conversation(cwd, PARENT_SESSION);
  const child = conversation(cwd, CHILD_SESSION);
  const grandchild = conversation(cwd, GRANDCHILD_SESSION);

  try {
    // Every conversation reads its own transcript before anything is bound.
    for (const talker of [parent, child, grandchild]) {
      assert.equal(
        await beforeAgentStart({ prompt: "work", images: undefined, systemPrompt: "system" }, talker.ctx),
        undefined,
        "an unbound conversation has no Phase Contract yet",
      );
    }
    assert.deepEqual(appendedEntries, []);

    // Each conversation starts its own run the way its own cad kernel does.
    const runs = new Map<string, string>();
    for (const sessionId of [PARENT_SESSION, CHILD_SESSION, GRANDCHILD_SESSION]) {
      const run = await new HarnessProjectStoreV7(cwd).startConversationRun({
        sessionId,
        workflow: workflow(),
        registryContract: buildRegistryContract(mechanicalRegistries),
      });
      runs.set(sessionId, run.state.runId);
    }
    assert.equal(new Set(runs.values()).size, 3, "each conversation owns a distinct run");
    // The project pointer is untouched: conversation lifecycle is not project lifecycle.
    assert.equal((await new HarnessProjectStoreV7(cwd).load()).state.currentRunId, null);

    // A Phase Contract is delivered per conversation, from that conversation's run.
    for (const [talker, sessionId] of [[parent, PARENT_SESSION], [child, CHILD_SESSION], [grandchild, GRANDCHILD_SESSION]] as const) {
      const delivery = await beforeAgentStart({ prompt: "continue", images: undefined, systemPrompt: "system" }, talker.ctx);
      assert.ok(delivery?.message, `conversation ${sessionId} must receive its own contract`);
    }
    assert.deepEqual(appendedEntries.map((entry) => bindingOf(entry)), [
      { sessionId: PARENT_SESSION, runId: runs.get(PARENT_SESSION) },
      { sessionId: CHILD_SESSION, runId: runs.get(CHILD_SESSION) },
      { sessionId: GRANDCHILD_SESSION, runId: runs.get(GRANDCHILD_SESSION) },
    ]);

    // The child finishes its own run; its parent's and its child's stay open.
    await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "checked", sessionId: CHILD_SESSION });

    // The refine gate answers for the conversation that asked. The parent spoke
    // first and its sibling spoke last, so a shared scope would answer with the
    // child's finished run and wrongly release the parent.
    assert.equal(await beforeAgentStart({ prompt: "parent again", images: undefined, systemPrompt: "system" }, parent.ctx), undefined);
    assert.equal(await beforeAgentStart({ prompt: "child again", images: undefined, systemPrompt: "system" }, child.ctx), undefined);
    assert.deepEqual(await beforeRefine({}, parent.ctx), { skip: true }, "the parent's open run keeps refine off");
    assert.equal(await beforeRefine({}, child.ctx), undefined, "the child's finished run releases refine");
    assert.deepEqual(await beforeRefine({}, grandchild.ctx), { skip: true }, "the grandchild's open run keeps refine off");

    // The kernel names its own session, and the extension never writes one.
    assert.equal(process.env.PI_CAD_SESSION_ID, undefined);

    // A caller that names only its session — the cad Python kernel — still
    // resolves that conversation's run through the registry, not the project
    // pointer.
    const current = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-current", sessionId: CHILD_SESSION });
    assert.equal(current.ok, true, current.error?.message);
    assert.equal((current as any).result.runId, runs.get(CHILD_SESSION));
  } finally {
    await sidecar.close();
    if (previousSocket === undefined) delete process.env.PI_CAD_AUTHOR_SOCKET;
    else process.env.PI_CAD_AUTHOR_SOCKET = previousSocket;
    if (previousSessionId === undefined) delete process.env.PI_CAD_SESSION_ID;
    else process.env.PI_CAD_SESSION_ID = previousSessionId;
    await rm(cwd, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
