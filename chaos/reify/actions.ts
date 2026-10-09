import fc from "fast-check";

import type { ReifyContext, ReifyActionDefinition, Params } from "./types.ts";

/**
 * Real user / agent behaviour against the real Reify authority.
 *
 * Every action here is an operation the product really serves
 * (`workflow-*`, `commit`, `model-build`, `viewer-catalog`, `load`,
 * `history`, `phase-card`, `phase-contract`, `completion-gate`, `authorize`)
 * or a real lifecycle event on the process the Desktop drives. Nothing is a
 * stub: whoever the request reaches is production Reify code.
 */

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

/** A real build output path that cannot collide with a previous build. */
let actionBuildCounter = 0;
function buildOutput(conversation: string, tag: string): string {
  return `build/action-${tag}-${++actionBuildCounter}-${conversation}.step`;
}

/**
 * `phase-card` / `phase-contract` / `completion-gate` / `authorize` are
 * operations of the long-lived authority sidecar, which is what the Desktop
 * and Prime really talk to. A one-shot CLI authority does not expose them, so
 * a run that is not driving the runtime skips them explicitly instead of
 * spraying rejected requests into the trace.
 */
function sidecarOnly(ctx: ReifyContext, name: string): boolean {
  if (ctx.session.attachedRuntime) return true;
  ctx.trace.note(`${name} 跳过：这是常驻 sidecar 面上的操作，用 --runtime 才有`);
  return false;
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

/**
 * Walk a run from `plan` to `cook` the way the workflow really allows it:
 * commit the `plan` the phase obligation asks for, then run the `plan_ready`
 * transition. These are the same two real operations `REIFY_SETUP` uses, so a
 * conversation this harness drives is in the phase a user really works in.
 */
async function commitPlanAndAdvance(ctx: ReifyContext, conversation: string): Promise<{ commit?: string; phase?: string }> {
  const manifest = (await ctx.session.call("commit", { name: "plan", sessionId: conversation })) as { id?: string };
  const advanced = (await ctx.session.call("workflow-advance", {
    event: "plan_ready",
    sessionId: conversation,
  })) as { phase?: string; status?: string };
  return { commit: manifest?.id, phase: advanced?.phase };
}

/**
 * A real second Prime conversation that a user can really work in: its own
 * run, its plan committed, its run advanced to `cook`.
 *
 * Driving only `workflow-start` leaves the new run in `plan`, where
 * `model.build` is not granted at all. A conversation like that is not a
 * working conversation, so every multi-conversation scenario (two builds at
 * once, one conversation faulted while the other works) silently degraded to
 * the single-conversation case and reported NotApplicable forever. This walks
 * the two real operations that actually get a run to `cook`.
 */
export async function openWorkingConversation(ctx: ReifyContext): Promise<string> {
  const conversation = ctx.session.addConversation();
  const view = (await ctx.session.call("workflow-start", {
    id: "mechanical.default",
    sessionId: conversation,
  })) as { runId?: string; status?: string };
  if (typeof view.runId !== "string") throw new Error("workflow-start 没有返回 runId");
  ctx.session.history.runsByConversation.set(conversation, [view.runId]);
  const ready = await commitPlanAndAdvance(ctx, conversation);
  ctx.trace.record({
    kind: "command",
    name: "openConversation",
    detail: { conversation, runId: view.runId, commit: ready.commit, phase: ready.phase },
  });
  return conversation;
}

/**
 * A second real Prime conversation, which must keep its own run binding.
 *
 * The conversation is driven to `cook` on purpose. A run that stops at
 * `workflow-start` sits in `plan`, where `model.build` is simply not granted;
 * a second conversation like that is not a working conversation, and the
 * multi-conversation races (two builds at once, one conversation faulted
 * while the other works) could never really be injected — they reported
 * NotApplicable forever. Opening a conversation a user can work in means
 * committing its plan and advancing it, exactly like the round's own setup.
 */
export const openConversation: ReifyActionDefinition = {
  name: "openConversation",
  description: "开一个新 Prime 会话，并让它自己的 run 走到能真干活的阶段",
  arbitrary: fc.constant<Params>({}),
  describe: () => "openConversation",
  run: guarded("openConversation", async (ctx) => {
    await openWorkingConversation(ctx);
  }),
};

/**
 * Real conversation switch: the caller becomes a different Prime conversation
 * and reads *its* run. A switch that leaks another conversation's run is
 * exactly what `run-ownership` exists to catch.
 */
export const switchConversation: ReifyActionDefinition = {
  name: "switchConversation",
  description: "切到另一个 Prime 会话，读它自己的 run",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `switchConversation(conv#${params.conversationIndex})`,
  run: guarded("switchConversation", async (ctx) => {
    const conversation = conversationOf(ctx);
    const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as
      | { runId?: string; phase?: string; status?: string; binding?: { sessionId?: string; runId?: string } }
      | null;
    const catalog = (await ctx.session.call("viewer-catalog", { sessionId: conversation })) as {
      currentRun?: { id?: string } | null;
    };
    ctx.trace.record({
      kind: "command",
      name: "switchConversation",
      detail: {
        conversation,
        runId: view?.runId ?? null,
        bindingSession: view?.binding?.sessionId ?? null,
        catalogRun: catalog?.currentRun?.id ?? null,
        status: view?.status ?? null,
      },
    });
  }),
};

/** Resume a conversation's run from disk with the real `load` operation. */
export const resumeRun: ReifyActionDefinition = {
  name: "resumeRun",
  description: "用真 load 从 run store 恢复一个 run，再读它的真状态",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `resumeRun(conv#${params.conversationIndex})`,
  run: guarded("resumeRun", async (ctx) => {
    const conversation = conversationOf(ctx);
    const runId = await activeRunOf(ctx.session, conversation);
    if (!runId) {
      ctx.trace.note("resumeRun 跳过：这个会话还没有 run");
      return;
    }
    const loaded = (await ctx.session.call("load", { id: runId, sessionId: conversation })) as {
      state?: { phase?: string; status?: string };
    };
    const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as { status?: string } | null;
    ctx.trace.record({
      kind: "command",
      name: "resumeRun",
      detail: { conversation, runId, loadedPhase: loaded?.state?.phase ?? null, loadedStatus: loaded?.state?.status ?? null, currentStatus: view?.status ?? null },
    });
  }),
};

/** Real `history`: the run's commit chain as the product reports it. */
export const history: ReifyActionDefinition = {
  name: "history",
  description: "读真 run 的 commit 历史",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `history(conv#${params.conversationIndex})`,
  run: guarded("history", async (ctx) => {
    const conversation = conversationOf(ctx);
    const entries = (await ctx.session.call("history", { sessionId: conversation })) as unknown;
    ctx.trace.record({
      kind: "command",
      name: "history",
      detail: { conversation, count: Array.isArray(entries) ? entries.length : null },
    });
  }),
};

/** Real `workflow-list`: every installed workflow the authority can start. */
export const listWorkflows: ReifyActionDefinition = {
  name: "listWorkflows",
  description: "列出真 authority 装着的 workflow",
  arbitrary: fc.constant<Params>({}),
  describe: () => "listWorkflows",
  run: guarded("listWorkflows", async (ctx) => {
    const list = (await ctx.session.call("workflow-list")) as unknown;
    ctx.trace.record({ kind: "command", name: "listWorkflows", detail: { count: Array.isArray(list) ? list.length : null } });
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

/** Duplicate submit: the same commit twice, nearly back to back. */
export const duplicateCommit: ReifyActionDefinition = {
  name: "duplicateCommit",
  description: "同一个 commit 快速提交两次（重复点击）",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `duplicateCommit(conv#${params.conversationIndex})`,
  run: guarded("duplicateCommit", async (ctx) => {
    const conversation = conversationOf(ctx);
    const ids: string[] = [];
    const errors: string[] = [];
    await Promise.all(
      [0, 1].map(async () => {
        try {
          const manifest = (await ctx.session.call("commit", { name: "plan", sessionId: conversation })) as { id?: string };
          if (manifest?.id) ids.push(manifest.id);
        } catch (error) {
          errors.push((error as Error).message);
        }
      }),
    );
    ctx.trace.record({ kind: "command", name: "duplicateCommit", detail: { conversation, commits: ids, errors } });
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

/** Stop a run by walking the workflow's own terminal transition. */
export const stopRun: ReifyActionDefinition = {
  name: "stopRun",
  description: "用 workflow 自己的终态 transition 停掉 run",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `stopRun(conv#${params.conversationIndex})`,
  run: guarded("stopRun", async (ctx) => {
    const conversation = conversationOf(ctx);
    const result = (await ctx.session.call("workflow-advance", { event: "finished", sessionId: conversation })) as {
      phase?: string;
      status?: string;
    };
    ctx.trace.record({ kind: "command", name: "stopRun", detail: { conversation, ...result } });
  }),
};

/**
 * Real `model-build`: the authority spawns its warm `cadctl.worker`, builds
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
    const output = buildOutput(conversation, source.replace(/\.py$/, ""));
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

/** Retry the same build with `force`, which is the real "build again" user action. */
export const retryBuild: ReifyActionDefinition = {
  name: "retryBuild",
  description: "同一个 build 强制重跑（retry）",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `retryBuild(conv#${params.conversationIndex})`,
  run: guarded("retryBuild", async (ctx) => {
    const conversation = conversationOf(ctx);
    const result = (await ctx.session.call("model-build", {
      source: "part.py",
      output: buildOutput(conversation, "retry"),
      validation: "fast",
      force: true,
      sessionId: conversation,
    })) as { build?: { ok?: boolean; durationMs?: number } };
    ctx.trace.record({ kind: "command", name: "retryBuild", detail: { conversation, ok: result.build?.ok ?? false } });
    if (result.build?.ok) ctx.session.recordRecovery("retryBuild", result.build.durationMs ?? 0);
  }),
};

/** Two real builds really in flight at the same time in one conversation. */
export const concurrentBuild: ReifyActionDefinition = {
  name: "concurrentBuild",
  description: "同一个会话里同时跑两个真 build",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 1 }) }),
  describe: (params) => `concurrentBuild(conv#${params.conversationIndex})`,
  run: guarded("concurrentBuild", async (ctx) => {
    const conversation = conversationOf(ctx);
    const outputs = [buildOutput(conversation, "concurrent-a"), buildOutput(conversation, "concurrent-b")];
    const results = await Promise.all(
      outputs.map(async (output) => {
        try {
          const result = (await ctx.session.call("model-build", {
            source: "part.py",
            output,
            validation: "fast",
            sessionId: conversation,
          })) as { build?: { ok?: boolean; durationMs?: number } };
          if (result.build?.ok) ctx.session.recordRecovery(`concurrentBuild:${output}`, result.build.durationMs ?? 0);
          return { output, ok: result.build?.ok ?? false };
        } catch (error) {
          return { output, ok: false, error: (error as Error).message };
        }
      }),
    );
    ctx.trace.record({ kind: "command", name: "concurrentBuild", detail: { conversation, results } });
  }),
};

/** Two conversations really working at the same time. */
export const multiConversationBuild: ReifyActionDefinition = {
  name: "multiConversationBuild",
  description: "两个真会话同时跑真 build",
  arbitrary: fc.constant<Params>({}),
  describe: () => "multiConversationBuild",
  run: guarded("multiConversationBuild", async (ctx) => {
    // Two conversations that may really build come from the round's own
    // preparation (`REIFY_MULTI_CONVERSATION_SETUP`), not from this action
    // quietly opening one. With a single conversation it degrades to a
    // single-conversation build and the trace says so.
    if (ctx.session.conversations.length < 2) ctx.trace.note("multiConversationBuild 只有一个会话，退化成单会话 build");
    const conversations = [ctx.session.conversation(0)];
    if (ctx.session.conversations.length > 1) conversations.push(ctx.session.conversation(1));
    const results = await Promise.all(
      conversations.map(async (conversation) => {
        try {
          const result = (await ctx.session.call("model-build", {
            source: "part.py",
            output: buildOutput(conversation, "multi"),
            validation: "fast",
            sessionId: conversation,
          })) as { build?: { ok?: boolean; durationMs?: number } };
          if (result.build?.ok) ctx.session.recordRecovery(`multiConversationBuild:${conversation}`, result.build.durationMs ?? 0);
          return { conversation, ok: result.build?.ok ?? false };
        } catch (error) {
          return { conversation, ok: false, error: (error as Error).message };
        }
      }),
    );
    ctx.trace.record({ kind: "command", name: "multiConversationBuild", detail: { results } });
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

/** Rapid consecutive refreshes: the "user hammering the refresh button" case. */
export const burstRefresh: ReifyActionDefinition = {
  name: "burstRefresh",
  description: "连续快速刷新多次（页面 refresh / 重复请求）",
  arbitrary: fc.record({ times: fc.integer({ min: 2, max: 4 }), conversationIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `burstRefresh(${params.times},conv#${params.conversationIndex})`,
  run: guarded("burstRefresh", async (ctx) => {
    const conversation = conversationOf(ctx);
    const times = Number(ctx.params.times ?? 2);
    const results = await Promise.all(
      Array.from({ length: times }, async () => {
        try {
          const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as { runId?: string; status?: string } | null;
          return { runId: view?.runId ?? null, status: view?.status ?? null };
        } catch (error) {
          return { error: (error as Error).message };
        }
      }),
    );
    ctx.trace.record({ kind: "command", name: "burstRefresh", detail: { conversation, times, distinctRunIds: new Set(results.map((r) => r.runId)).size } });
  }),
};

/** Real `phase-card`: the phase picture the Desktop rail renders. */
export const phaseCard: ReifyActionDefinition = {
  name: "phaseCard",
  description: "读真 phase-card（Desktop 阶段卡片）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "phaseCard",
  run: guarded("phaseCard", async (ctx) => {
    if (!sidecarOnly(ctx, "phaseCard")) return;
    const card = (await ctx.session.call("phase-card", { sessionId: conversationOf(ctx) })) as { phase?: string };
    ctx.trace.record({ kind: "command", name: "phaseCard", detail: { phase: card?.phase ?? null } });
  }),
};

/** Real `phase-contract`: the obligations the current phase enforces. */
export const phaseContract: ReifyActionDefinition = {
  name: "phaseContract",
  description: "读真 phase-contract（当前阶段义务）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "phaseContract",
  run: guarded("phaseContract", async (ctx) => {
    if (!sidecarOnly(ctx, "phaseContract")) return;
    const contract = (await ctx.session.call("phase-contract", { sessionId: conversationOf(ctx) })) as { phase?: string; obligations?: unknown[] };
    ctx.trace.record({
      kind: "command",
      name: "phaseContract",
      detail: { phase: contract?.phase ?? null, obligations: contract?.obligations?.length ?? null },
    });
  }),
};

/** Real `completion-gate`: whether the run may finish, judged by the product. */
export const completionGate: ReifyActionDefinition = {
  name: "completionGate",
  description: "问真 completion-gate 现在能不能收工",
  arbitrary: fc.constant<Params>({}),
  describe: () => "completionGate",
  run: guarded("completionGate", async (ctx) => {
    if (!sidecarOnly(ctx, "completionGate")) return;
    const gate = (await ctx.session.call("completion-gate", { sessionId: conversationOf(ctx) })) as { complete?: boolean; reason?: string };
    ctx.trace.record({ kind: "command", name: "completionGate", detail: { complete: gate?.complete ?? null, reason: gate?.reason ?? null } });
  }),
};

/** Real `authorize`: the product's own decision for one operation. */
export const authorize: ReifyActionDefinition = {
  name: "authorize",
  description: "问真 authorize 现在允不允许某个操作",
  arbitrary: fc.record({ operation: fc.constantFrom("model.build", "workspace.commit", "workflow.transition", "probe.run") }),
  describe: (params) => `authorize(${params.operation})`,
  run: guarded("authorize", async (ctx) => {
    if (!sidecarOnly(ctx, "authorize")) return;
    const decision = (await ctx.session.call("authorize", { operation: String(ctx.params.operation), sessionId: conversationOf(ctx) })) as {
      allowed?: boolean;
      reason?: string;
    };
    ctx.trace.record({ kind: "command", name: "authorize", detail: { operation: ctx.params.operation, allowed: decision?.allowed ?? null } });
  }),
};

/**
 * Desktop restart: the real runtime process behind the Desktop really goes
 * away and comes back while a run is live.
 */
export const desktopRestart: ReifyActionDefinition = {
  name: "desktopRestart",
  description: "重启常驻 runtime（Desktop 重启那条路）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "desktopRestart",
  run: guarded("desktopRestart", async (ctx) => {
    const runtime = ctx.session.attachedRuntime;
    if (!runtime) {
      ctx.trace.note("desktopRestart 跳过：这一轮没有挂常驻 runtime");
      return;
    }
    const conversation = conversationOf(ctx);
    const before = (await ctx.session.call("workflow-current", { sessionId: conversation })) as { runId?: string } | null;
    const oldPid = runtime.pid;
    const restarted = await runtime.restart();
    ctx.session.registerAuthorityPid(restarted.pid, "runtime");
    const after = (await ctx.session.call("workflow-current", { sessionId: conversation })) as { runId?: string; status?: string } | null;
    ctx.trace.record({
      kind: "command",
      name: "desktopRestart",
      detail: { oldPid, newPid: restarted.pid, beforeRunId: before?.runId ?? null, afterRunId: after?.runId ?? null, afterStatus: after?.status ?? null },
    });
    if (before?.runId && after?.runId !== before.runId) {
      ctx.trace.note(`重启后 run 变了：${before.runId} → ${after?.runId ?? "无"}`);
    }
  }),
};

export const reifyActionDefinitions: ReifyActionDefinition[] = [
  startRun,
  openConversation,
  switchConversation,
  resumeRun,
  listWorkflows,
  history,
  commitPlan,
  duplicateCommit,
  advance,
  stopRun,
  build,
  retryBuild,
  concurrentBuild,
  multiConversationBuild,
  refresh,
  burstRefresh,
  phaseCard,
  phaseContract,
  completionGate,
  authorize,
  desktopRestart,
];

export { activeRunOf };
