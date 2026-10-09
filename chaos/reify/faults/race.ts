/** Race faults: a real user action or a second conversation lands during a fault. */

import fc from "fast-check";
import { FaultNotApplicable } from "../types.ts";
import type { Params, ReifyContext, ReifyFaultDefinition } from "../types.ts";
import {
  FAST_SOURCE,
  faultConversationIndex,
  conversationOf,
  runViewOrThrow,
  buildAllowed,
  commitAllowed,
  legalTransitions,
  transitionDeniedByProduct,
  buildableRunPrecondition,
  startFaultBuild,
  settleWithin,
  proveRecovery,
  describeKernel,
  nextBuildId,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Race / 时序：故障和用户操作真的同时或交叉发生
// ---------------------------------------------------------------------------

/** Run a user action and a fault really concurrently, not one after another. */
async function concurrently(steps: Array<() => Promise<void>>): Promise<void> {
  await Promise.all(steps.map((step) => step()));
}

/**
 * A user action fired while a kernel fault is already injected: the fault and
 * the recovery path overlap instead of being cleanly separated.
 */
export const raceUserActionDuringKernelFault: ReifyFaultDefinition = {
  name: "raceUserActionDuringKernelFault",
  description: "故障还在挂着的时候再跑用户操作（故障与用户操作同时发生）",
  arbitrary: fc.record({
    action: fc.constantFrom("refresh", "viewerCatalog", "retryBuild"),
    conversationIndex: fc.integer({ min: 0, max: 1 }),
  }),
  describe: (params) => `raceUserActionDuringKernelFault(${params.action},conv#${params.conversationIndex})`,
  precondition: async (ctx) => {
    // The authority sidecar (the long-lived runtime Desktop and Prime talk to)
    // does not expose `viewer-catalog`; only the one-shot CLI authority does.
    // Asking for it on the runtime threw "author endpoint does not expose
    // operation: viewer-catalog" and the runner honestly reported an injection
    // failure — a harness fault, not a product one. Say "not applicable"
    // instead, the same way the sidecar-only actions do it the other way round.
    if (String(ctx.params.action) === "viewerCatalog" && ctx.session.attachedRuntime) {
      return { applicable: false, reason: "常驻 runtime 面不暴露 viewer-catalog，只有一次性 CLI 控制面才有" };
    }
    return buildableRunPrecondition(ctx);
  },
  inject: async (ctx) => {
    const index = faultConversationIndex(ctx);
    if (String(ctx.params.action) === "viewerCatalog" && ctx.session.attachedRuntime) {
      throw new FaultNotApplicable("常驻 runtime 面不暴露 viewer-catalog，只有一次性 CLI 控制面才有");
    }
    // The faulted kernel and the user action must be the same conversation.
    const build = await startFaultBuild(ctx, "raceUserActionDuringKernelFault", index);
    ctx.session.killKernel(build.kernelPid, "SIGKILL");
    await concurrently([
      async () => {
        const action = String(ctx.params.action);
        ctx.trace.note(`race：故障挂着时跑用户操作 ${action}`);
        if (action === "refresh") await readWorkflow(ctx, index);
        else if (action === "viewerCatalog") await readCatalog(ctx, index);
        else await retryBuild(ctx, index);
      },
      async () => {
        await settleWithin(build, 20_000);
      },
    ]);
    ctx.trace.record({ kind: "note", name: "raceUserActionDuringKernelFault", detail: { action: ctx.params.action } });
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "raceUserActionDuringKernelFault", faultConversationIndex(ctx));
    ctx.session.disarmFault("raceUserActionDuringKernelFault");
  },
};

/** Two real conversations build at the same time; one kernel dies mid-flight. */
export const raceTwoConversationsBuild: ReifyFaultDefinition = {
  name: "raceTwoConversationsBuild",
  description: "两个会话同时真 build，其中一个 build 途中被杀",
  arbitrary: fc.constant<Params>({}),
  describe: () => "raceTwoConversationsBuild",
  precondition: async (ctx) => {
    // Two conversations, not the same conversation twice: without a second
    // real conversation this is not the multi-conversation race at all. A
    // round that wants this fault prepares the second working conversation up
    // front (`REIFY_MULTI_CONVERSATION_SETUP`), so the preparation is a real
    // command in the sequence this fault ran in, not state the fault invents.
    if (ctx.session.conversations.length < 2) {
      return { applicable: false, reason: "只有一个会话；多会话 race 要先 openConversation" };
    }
    const first = ctx.session.conversation(0);
    const second = ctx.session.conversation(1);
    const firstView = await runViewOrThrow(ctx, first);
    if (firstView.status !== "active") return { applicable: false, reason: `会话 ${first} 还没有 active run` };
    const secondView = await runViewOrThrow(ctx, second);
    if (secondView.status !== "active") return { applicable: false, reason: `第二个会话 ${second} 还没有 active run（先 openConversation）` };
    if (!(await buildAllowed(ctx, first))) return { applicable: false, reason: `会话 ${first} 当前阶段不允许 model.build` };
    if (!(await buildAllowed(ctx, second))) return { applicable: false, reason: `会话 ${second} 当前阶段不允许 model.build` };
    return { applicable: true, evidence: { first, second, runs: [firstView.runId, secondView.runId] } };
  },
  inject: async (ctx) => {
    const first = await startFaultBuild(ctx, "raceTwoConversationsBuild", 0);
    const second = await startFaultBuild(ctx, "raceTwoConversationsBuild", 1);
    ctx.session.killKernel(first.kernelPid, "SIGKILL");
    ctx.trace.record({
      kind: "note",
      name: "raceTwoConversationsBuild",
      detail: { killed: describeKernel(first), other: describeKernel(second) },
    });
    await concurrently([
      async () => {
        await settleWithin(first, 30_000);
      },
      async () => {
        await settleWithin(second, 30_000);
      },
    ]);
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "raceTwoConversationsBuild", 0);
    await proveRecovery(ctx, "raceTwoConversationsBuild", 1);
    ctx.session.disarmFault("raceTwoConversationsBuild");
  },
};

/**
 * Restart the runtime while a real workflow transition is in flight.
 *
 * The precondition asks the product itself which events this run really
 * accepts right now, so an event that is illegal in the current phase can
 * never be counted as a transition race. If the product then refuses the
 * request before the restart takes effect, that refusal is reported as
 * NotApplicable instead of being swallowed and labelled `Injected`.
 */
export const raceRestartDuringTransition: ReifyFaultDefinition = {
  name: "raceRestartDuringTransition",
  description: "真 workflow transition 正在跑的时候重启 runtime",
  arbitrary: fc.record({ event: fc.constantFrom("plan_ready", "finished") }),
  describe: (params) => `raceRestartDuringTransition(${params.event})`,
  precondition: async (ctx) => {
    if (!ctx.session.attachedRuntime) {
      return { applicable: false, reason: "这一轮没有挂常驻 runtime（用 --runtime 驱动）" };
    }
    const conversation = conversationOf(ctx);
    const view = await runViewOrThrow(ctx, conversation);
    if (view.status !== "active") {
      return { applicable: false, reason: `会话 ${conversation} 没有 active run（${view.status ?? "无"}）` };
    }
    const event = String(ctx.params.event);
    const legal = await legalTransitions(ctx, conversation);
    if (!legal.includes(event)) {
      return {
        applicable: false,
        reason: `会话 ${conversation} 在 ${view.phase ?? "?"} 阶段不接受事件 ${event}（合法：${legal.join(", ") || "无"}）`,
        evidence: { conversation, runId: view.runId, phase: view.phase, event, legal },
      };
    }
    return { applicable: true, evidence: { conversation, runId: view.runId, phase: view.phase, event, legal } };
  },
  inject: async (ctx) => {
    const runtime = ctx.session.attachedRuntime!;
    const conversation = conversationOf(ctx);
    const event = String(ctx.params.event);
    // Fire the real transition and restart the runtime underneath it: the two
    // really overlap, and the request's own answer says what happened.
    const transition = ctx.session
      .call("workflow-advance", { event, sessionId: conversation })
      .then((result) => ({ result }), (error: Error) => ({ error: error.message }));
    const oldPid = runtime.pid;
    const restarted = await runtime.restart();
    ctx.session.registerAuthorityPid(restarted.pid, "runtime");
    const before = await transition;
    if (before.error && transitionDeniedByProduct(before.error)) {
      // The product answered while its runtime was still up: it refused the
      // transition, so no transition raced the restart.
      throw new FaultNotApplicable(`产品在重启生效前就拒了这个 transition：${before.error}`, {
        conversation,
        event,
        error: before.error,
      });
    }
    ctx.session.armFault("raceRestartDuringTransition");
    ctx.trace.record({
      kind: "note",
      name: "raceRestartDuringTransition",
      detail: { oldPid, newPid: restarted.pid, conversation, event, answer: before },
    });
  },
  recover: async (ctx) => {
    const conversation = conversationOf(ctx);
    const view = await runViewOrThrow(ctx, conversation);
    if (view.status === "active") await proveRecovery(ctx, "raceRestartDuringTransition");
    ctx.session.disarmFault("raceRestartDuringTransition");
  },
};

/**
 * Two legal operations run in the order the generator chose, in the same
 * conversation: A→B or B→A.
 *
 * The order is real — the first request settles before the second is sent — so
 * the two generated branches are genuinely different sequences instead of the
 * same concurrent pair under a different label. Both operations are checked to
 * be legal first, otherwise the "order" is between one real request and one
 * refusal.
 */
export const raceLegalOrderSwap: ReifyFaultDefinition = {
  name: "raceLegalOrderSwap",
  description: "两个合法操作按生成器选的顺序真串起来（build→commit 与 commit→build 两种）",
  arbitrary: fc.record({
    first: fc.constantFrom("build", "commitPlan"),
    conversationIndex: fc.integer({ min: 0, max: 1 }),
  }),
  describe: (params) => `raceLegalOrderSwap(${params.first},conv#${params.conversationIndex})`,
  precondition: async (ctx) => {
    const index = faultConversationIndex(ctx);
    const conversation = ctx.session.conversation(index);
    const view = await runViewOrThrow(ctx, conversation);
    if (view.status !== "active") {
      return { applicable: false, reason: `会话 ${conversation} 没有 active run（${view.status ?? "无"}）` };
    }
    // Both operations have to be really legal right now, or one of the two
    // "steps" is just a refusal and the swap means nothing.
    if (!(await buildAllowed(ctx, conversation))) {
      return { applicable: false, reason: `会话 ${conversation} 当前阶段 ${view.phase ?? "?"} 不允许 model.build` };
    }
    if (!(await commitAllowed(ctx, conversation))) {
      return { applicable: false, reason: `会话 ${conversation} 当前阶段 ${view.phase ?? "?"} 不允许 commit` };
    }
    return { applicable: true, evidence: { conversation, runId: view.runId, phase: view.phase } };
  },
  inject: async (ctx) => {
    const index = faultConversationIndex(ctx);
    const conversation = ctx.session.conversation(index);
    const view = await runViewOrThrow(ctx, conversation);
    const steps: Record<string, () => Promise<void>> = {
      build: () => retryBuild(ctx, index),
      commitPlan: () => commitPlanStep(ctx, index),
    };
    const first = String(ctx.params.first);
    const second = first === "build" ? "commitPlan" : "build";
    // The generated order is the real order: the first operation answers
    // before the second one is sent, so A→B and B→A really differ.
    await steps[first]!();
    await steps[second]!();
    ctx.session.armFault("raceLegalOrderSwap");
    ctx.trace.record({
      kind: "note",
      name: "raceLegalOrderSwap",
      detail: { conversation, runId: view.runId, order: [first, second] },
    });
  },
  recover: async (ctx) => {
    ctx.session.disarmFault("raceLegalOrderSwap");
  },
};

/** Repeat the same submit while a fault is armed: duplicate side effects must not appear. */
export const raceRepeatSubmitDuringFault: ReifyFaultDefinition = {
  name: "raceRepeatSubmitDuringFault",
  description: "故障挂着的时候同一个操作重复提交（重复副作用风险）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "raceRepeatSubmitDuringFault",
  precondition: (ctx) => buildableRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "raceRepeatSubmitDuringFault");
    ctx.session.killKernel(build.kernelPid, "SIGKILL");
    const index = 0;
    await concurrently([
      async () => {
        await commitPlanStep(ctx, index);
      },
      async () => {
        await commitPlanStep(ctx, index);
      },
      async () => {
        await settleWithin(build, 20_000);
      },
    ]);
    ctx.trace.record({ kind: "note", name: "raceRepeatSubmitDuringFault", detail: { detail: describeKernel(build) } });
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "raceRepeatSubmitDuringFault");
    ctx.session.disarmFault("raceRepeatSubmitDuringFault");
  },
};

/** A fault injected in one conversation while another conversation keeps working. */
export const raceCrossConversationFault: ReifyFaultDefinition = {
  name: "raceCrossConversationFault",
  description: "会话 A 被打故障的同时，会话 B 一直在做真操作",
  arbitrary: fc.record({
    faultedIndex: fc.integer({ min: 0, max: 1 }),
  }),
  describe: (params) => `raceCrossConversationFault(conv#${params.faultedIndex})`,
  precondition: async (ctx) => {
    // Strict on purpose: the fault only runs when the second real conversation
    // and its active run are already there. The round prepares that up front
    // (`REIFY_MULTI_CONVERSATION_SETUP`), so "how the system got here" stays in
    // the recorded sequence instead of inside the fault.
    if (ctx.session.conversations.length < 2) {
      return { applicable: false, reason: "只有一个会话；跨会话 race 要先 openConversation" };
    }
    const faulted = Number(ctx.params.faultedIndex ?? 0);
    const faultedConversation = ctx.session.conversation(faulted);
    const other = ctx.session.conversation(faulted === 0 ? 1 : 0);
    const view = await runViewOrThrow(ctx, other);
    if (view.status !== "active") return { applicable: false, reason: `另一个会话 ${other} 还没有 active run` };
    if (!(await buildAllowed(ctx, faultedConversation))) {
      return { applicable: false, reason: `会话 ${faultedConversation} 当前阶段不允许 model.build` };
    }
    return { applicable: true, evidence: { faulted: faultedConversation, other, otherRunId: view.runId } };
  },
  inject: async (ctx) => {
    const faulted = Number(ctx.params.faultedIndex ?? 0);
    const other = faulted === 0 ? 1 : 0;
    const build = await startFaultBuild(ctx, "raceCrossConversationFault", faulted);
    ctx.session.killKernel(build.kernelPid, "SIGKILL");
    await concurrently([
      async () => {
        await settleWithin(build, 20_000);
      },
      async () => {
        await readWorkflow(ctx, other);
        await retryBuild(ctx, other);
      },
    ]);
    ctx.trace.record({ kind: "note", name: "raceCrossConversationFault", detail: { faulted, other } });
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "raceCrossConversationFault", Number(ctx.params.faultedIndex ?? 0));
    ctx.session.disarmFault("raceCrossConversationFault");
  },
};

// ---------------------------------------------------------------------------

// Small helpers shared with the race faults (they really drive the product).
// ---------------------------------------------------------------------------

async function readWorkflow(ctx: ReifyContext, conversationIndex: number): Promise<void> {
  const conversation = conversationOf(ctx, conversationIndex);
  const view = await ctx.session.call("workflow-current", { sessionId: conversation });
  ctx.trace.record({ kind: "command", name: "race:readWorkflow", detail: { conversation, view } });
}

async function readCatalog(ctx: ReifyContext, conversationIndex: number): Promise<void> {
  const conversation = conversationOf(ctx, conversationIndex);
  const catalog = await ctx.session.call("viewer-catalog", { sessionId: conversation });
  ctx.trace.record({ kind: "command", name: "race:viewerCatalog", detail: { conversation, catalog } });
}

async function retryBuild(ctx: ReifyContext, conversationIndex: number): Promise<void> {
  const conversation = conversationOf(ctx, conversationIndex);
  try {
    const result = (await ctx.session.call("model-build", {
      source: FAST_SOURCE,
      output: `build/chaos-retry-${nextBuildId()}-${conversation}.step`,
      validation: "fast",
      force: true,
      sessionId: conversation,
    })) as { build?: { ok?: boolean; durationMs?: number } };
    ctx.trace.record({ kind: "command", name: "race:retryBuild", detail: { conversation, ok: result.build?.ok ?? false } });
    if (result.build?.ok) ctx.session.recordRecovery(`race:retryBuild:${conversation}`, result.build.durationMs ?? 0);
  } catch (error) {
    ctx.trace.note(`race:retryBuild 被拒：${(error as Error).message}`);
  }
}

async function commitPlanStep(ctx: ReifyContext, conversationIndex: number): Promise<void> {
  const conversation = conversationOf(ctx, conversationIndex);
  try {
    const manifest = (await ctx.session.call("commit", { name: "plan", sessionId: conversation })) as { id?: string };
    ctx.trace.record({ kind: "command", name: "race:commitPlan", detail: { conversation, commit: manifest?.id } });
  } catch (error) {
    ctx.trace.note(`race:commitPlan 被拒：${(error as Error).message}`);
  }
}
