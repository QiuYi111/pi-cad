import fc from "fast-check";

import type { ReifyContext, ReifyActionDefinition, Params } from "./types.ts";

/** Actions never throw on a rejected request: the invariants judge the state. */
function guarded(name: string, run: (ctx: ReifyContext) => Promise<void>): (ctx: ReifyContext) => Promise<void> {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (error) {
      ctx.trace.note(`${name} 被拒`, (error as Error).message);
    }
  };
}

function conversationOf(ctx: ReifyContext): string {
  return ctx.session.conversation(Number(ctx.params.conversationIndex ?? 0));
}

async function activeRunOf(session: ReifyContext["session"], conversation: string): Promise<string | null> {
  const view = await session.call("workflow-current", { sessionId: conversation });
  const runId = (view as { runId?: string } | null)?.runId;
  return typeof runId === "string" ? runId : null;
}

/** Real `workflow-start`: the conversation gets its own run in the real run store. */
export const startRun: ReifyActionDefinition = {
  name: "startRun",
  description: "在一个 Prime 会话里开始真 run",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `startRun(conv#${params.conversationIndex})`,
  run: guarded("startRun", async (ctx) => {
    const conversation = conversationOf(ctx);
    const view = (await ctx.session.call("workflow-start", {
      id: "mechanical.default",
      sessionId: conversation,
    })) as { runId?: string; phase?: string; status?: string };
    if (typeof view.runId !== "string") throw new Error("workflow-start 没有返回 runId");
    const runs = ctx.session.history.runsByConversation.get(conversation) ?? [];
    runs.push(view.runId);
    ctx.session.history.runsByConversation.set(conversation, runs);
    ctx.trace.record({
      kind: "command",
      name: "startRun",
      detail: { conversation, runId: view.runId, phase: view.phase, status: view.status },
    });
  }),
};

/** A second real Prime conversation, which must keep its own run binding. */
export const openConversation: ReifyActionDefinition = {
  name: "openConversation",
  description: "开一个新 Prime 会话并起它自己的 run",
  arbitrary: fc.constant<Params>({}),
  describe: () => "openConversation",
  run: guarded("openConversation", async (ctx) => {
    const conversation = ctx.session.addConversation();
    const view = (await ctx.session.call("workflow-start", {
      id: "mechanical.default",
      sessionId: conversation,
    })) as { runId?: string; status?: string };
    if (typeof view.runId !== "string") throw new Error("workflow-start 没有返回 runId");
    ctx.session.history.runsByConversation.set(conversation, [view.runId]);
    ctx.trace.record({ kind: "command", name: "openConversation", detail: { conversation, runId: view.runId } });
  }),
};

/** Real `commit`: closes the plan obligation the `plan_ready` transition requires. */
export const commitPlan: ReifyActionDefinition = {
  name: "commitPlan",
  description: "在真 run 里提交 plan",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `commitPlan(conv#${params.conversationIndex})`,
  run: guarded("commitPlan", async (ctx) => {
    const conversation = conversationOf(ctx);
    const manifest = (await ctx.session.call("commit", {
      name: "plan",
      sessionId: conversation,
    })) as { id?: string };
    ctx.trace.record({ kind: "command", name: "commitPlan", detail: { conversation, commit: manifest.id } });
  }),
};

/** Real `workflow-advance`: only the workflow's own legal events are offered. */
export const advance: ReifyActionDefinition = {
  name: "advance",
  description: "走 workflow 的真 transition",
  arbitrary: fc.record({ event: fc.constantFrom("plan_ready", "finished"), conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `advance(${params.event},conv#${params.conversationIndex})`,
  run: guarded("advance", async (ctx) => {
    const conversation = conversationOf(ctx);
    const result = (await ctx.session.call("workflow-advance", {
      event: String(ctx.params.event),
      sessionId: conversation,
    })) as { phase?: string; status?: string };
    ctx.trace.record({ kind: "command", name: "advance", detail: { conversation, event: ctx.params.event, ...result } });
  }),
};

/**
 * Real `model-build`: the Agent API spawns its warm `cadctl.worker`, builds
 * real build123d geometry and renders the mandatory views.
 */
export const build: ReifyActionDefinition = {
  name: "build",
  description: "真 model-build（真 cadctl kernel 出 STEP）",
  arbitrary: fc.record({
    source: fc.constantFrom("part.py", "slow_part.py"),
    conversationIndex: fc.integer({ min: 0, max: 2 }),
  }),
  describe: (params) => `build(${params.source},conv#${params.conversationIndex})`,
  run: guarded("build", async (ctx) => {
    const conversation = conversationOf(ctx);
    const source = String(ctx.params.source ?? "part.py");
    const output = `build/${source.replace(/\.py$/, "")}-${conversation}.step`;
    const startedAt = Date.now();
    const result = (await ctx.session.call("model-build", {
      source,
      output,
      validation: "fast",
      sessionId: conversation,
    })) as { build?: { ok?: boolean; durationMs?: number; payload?: { error?: string } } };
    const ok = result.build?.ok === true;
    ctx.trace.record({
      kind: "command",
      name: "build",
      detail: { conversation, source, output, ok, buildMs: result.build?.durationMs, wallMs: Date.now() - startedAt, error: result.build?.payload?.error },
    });
    if (ok) ctx.session.recordRecovery(`build:${source}`, result.build?.durationMs ?? Date.now() - startedAt);
  }),
};

/** Real reads: the phase picture and artifact catalog of every conversation. */
export const refresh: ReifyActionDefinition = {
  name: "refresh",
  description: "读真 workflow 状态和 artifact 目录",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `refresh(conv#${params.conversationIndex})`,
  run: guarded("refresh", async (ctx) => {
    const conversation = conversationOf(ctx);
    const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as { runId?: string; phase?: string; status?: string } | null;
    const catalog = (await ctx.session.call("viewer-catalog", { sessionId: conversation })) as {
      currentRun?: { id?: string; artifacts?: { id: string }[] } | null;
    };
    ctx.trace.record({
      kind: "command",
      name: "refresh",
      detail: {
        conversation,
        runId: view?.runId ?? null,
        phase: view?.phase ?? null,
        status: view?.status ?? null,
        artifacts: (catalog.currentRun?.artifacts ?? []).map((artifact) => artifact.id),
      },
    });
  }),
};

export const reifyActionDefinitions: ReifyActionDefinition[] = [startRun, openConversation, commitPlan, advance, build, refresh];

export { activeRunOf };
