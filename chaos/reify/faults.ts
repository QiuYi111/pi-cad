import fc from "fast-check";

import { InvariantViolation } from "../types.ts";
import type { ReifyContext, ReifyFaultDefinition, Params } from "./types.ts";

/** The slow model keeps the warm kernel busy long enough to be faulted. */
const SLOW_SOURCE = "slow_part.py";
const FAST_SOURCE = "part.py";
/** Real builds and real kernel restarts must finish inside this budget. */
const RECOVERY_BUDGET_MS = Number(process.env.CHAOS_REIFY_RECOVERY_BUDGET_MS ?? 90_000);
/** Each recovery build needs its own output path, otherwise cadctl serves a cache hit. */
let recoveryCounter = 0;

const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

/** The run of one conversation as the real API reports it right now. */
async function runView(ctx: ReifyContext, conversation: string): Promise<{ runId: string | null; status: string | null }> {
  const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as
    | { runId?: string; status?: string }
    | null;
  return { runId: view?.runId ?? null, status: view?.status ?? null };
}

interface FaultBuild {
  conversation: string;
  authorityPid: number;
  kernelPid: number;
  settle: () => Promise<{ code: number | null; signal: string | null; stdout: string }>;
}

/**
 * Start a real slow `model-build` and wait until its authority really owns a
 * live CAD kernel. Returns null when the system cannot reach that state, so a
 * fault never invents a failure the product did not have.
 */
async function startFaultBuild(ctx: ReifyContext, fault: string): Promise<FaultBuild | null> {
  const conversation = ctx.session.conversation(0);
  const view = await runView(ctx, conversation);
  if (view.status !== "active") {
    // A terminal run has no kernel to fault and no recovery obligation.
    ctx.trace.note("fault 跳过：会话没有 active run");
    return null;
  }
  const live = ctx.session.spawnCall("model-build", {
    source: SLOW_SOURCE,
    output: `build/${SLOW_SOURCE.replace(/\.py$/, "")}-${conversation}.step`,
    validation: "fast",
    sessionId: conversation,
  });
  const kernel = await Promise.race([
    ctx.session.waitForOwnedKernel(live.pid, 30_000),
    live.done.then(() => null),
  ]);
  if (!kernel) {
    ctx.trace.note("fault 跳过：没等到真的 kernel 进程");
    return null;
  }
  ctx.session.armFault(fault);
  return {
    conversation,
    authorityPid: live.pid,
    kernelPid: kernel.pid,
    settle: () => live.done,
  };
}

/** Wait for a real request to settle, without letting a hang eat the whole run. */
async function settleWithin(build: FaultBuild, timeoutMs: number): Promise<{ code: number | null; signal: string | null; stdout: string } | null> {
  return await Promise.race([build.settle(), sleep(timeoutMs).then(() => null)]);
}

/** A recovered system answers another real build with a real STEP artifact. */
async function proveRecovery(ctx: ReifyContext, after: string): Promise<void> {
  const conversation = ctx.session.conversation(0);
  const view = await runView(ctx, conversation);
  if (view.status !== "active") {
    ctx.trace.note(`${after} 之后 run 状态是 ${view.status ?? "无"}，不再要求重建`);
    return;
  }
  const startedAt = Date.now();
  try {
    const result = (await ctx.session.call(
      "model-build",
      {
        source: FAST_SOURCE,
        output: `build/recovery-${++recoveryCounter}-${conversation}.step`,
        validation: "fast",
        sessionId: conversation,
      },
      { timeoutMs: RECOVERY_BUDGET_MS },
    )) as { build?: { ok?: boolean; durationMs?: number; payload?: { error?: string; cache?: string } } };
    if (result.build?.ok !== true) throw new Error(result.build?.payload?.error ?? "build 没有返回 ok");
    const buildMs = result.build.durationMs ?? Date.now() - startedAt;
    const cache = result.build.payload?.cache ?? "unknown";
    ctx.session.recordRecovery(after, buildMs);
    ctx.trace.note(`恢复验证通过：${after} 之后真 build 成功（${buildMs}ms，cache=${cache}）`);
  } catch (error) {
    throw new InvariantViolation(
      "recovery-convergence",
      `${after} 之后系统没能恢复：${(error as Error).message}`,
      { after, conversation },
    );
  }
}

/** SIGKILL the real CAD kernel while it is inside a real build. */
export const killKernelDuringBuild: ReifyFaultDefinition = {
  name: "killKernelDuringBuild",
  description: "真 model-build 途中 SIGKILL 真 cadctl kernel",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killKernelDuringBuild",
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "killKernelDuringBuild");
    if (!build) throw new Error("没有可以下手的真 kernel");
    ctx.session.killKernel(build.kernelPid, "SIGKILL");
    ctx.trace.record({ kind: "note", name: "killKernelDuringBuild", detail: { kernelPid: build.kernelPid, authorityPid: build.authorityPid } });
    const settled = await settleWithin(build, 45_000);
    if (settled) {
      const message = (() => {
        try {
          return String((JSON.parse(settled.stdout) as { error?: { message?: string } }).error?.message ?? settled.signal ?? settled.code);
        } catch {
          return String(settled.signal ?? settled.code);
        }
      })();
      ctx.trace.note(`kernel 被杀后控制面报：${message}`);
    } else {
      // The control plane never noticed its kernel died; keep the run alive by
      // clearing the stale authority, and let recover() judge convergence.
      ctx.trace.note("kernel 被杀 45s 后控制面还没反应，按停顿记录");
      ctx.session.killKernel(build.authorityPid, "SIGKILL");
    }
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "killKernelDuringBuild");
    ctx.session.disarmFault("killKernelDuringBuild");
  },
};

/** SIGSTOP the real kernel mid-build, then let it run again with SIGCONT. */
export const pauseKernelDuringBuild: ReifyFaultDefinition = {
  name: "pauseKernelDuringBuild",
  description: "真 build 途中 SIGSTOP/SIGCONT 真 kernel",
  arbitrary: fc.constant<Params>({}),
  describe: () => "pauseKernelDuringBuild",
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "pauseKernelDuringBuild");
    if (!build) throw new Error("没有可以下手的真 kernel");
    ctx.session.killKernel(build.kernelPid, "SIGSTOP");
    ctx.session.armedFaults.set("pauseKernelDuringBuild", { kernelPid: build.kernelPid, build });
    const startedAt = Date.now();
    const settleWindowMs = Number(process.env.CHAOS_REIFY_PAUSE_MS ?? 3_000);
    await sleep(settleWindowMs);
    const stillPending = await Promise.race([build.settle().then(() => false), sleep(50).then(() => true)]);
    ctx.trace.note(
      `kernel 暂停 ${Date.now() - startedAt}ms 期间控制面 ${stillPending ? "没有任何反应（run 继续显示 active）" : "已经结束请求"}`,
    );
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("pauseKernelDuringBuild") as { kernelPid: number; build: FaultBuild } | undefined;
    ctx.session.disarmFault("pauseKernelDuringBuild");
    if (!armed) return;
    ctx.session.killKernel(armed.kernelPid, "SIGCONT");
    const settled = await settleWithin(armed.build, RECOVERY_BUDGET_MS);
    if (!settled) {
      throw new InvariantViolation("recovery-convergence", "kernel 恢复运行后真 build 仍没有结束", { kernelPid: armed.kernelPid });
    }
    ctx.trace.note(`kernel 恢复运行后请求结束（signal=${settled.signal ?? settled.code}）`);
  },
};

/** SIGKILL the real authority process while its warm kernel is mid-build. */
export const killAuthorityDuringBuild: ReifyFaultDefinition = {
  name: "killAuthorityDuringBuild",
  description: "真 build 途中 SIGKILL 真控制面进程",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killAuthorityDuringBuild",
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "killAuthorityDuringBuild");
    if (!build) throw new Error("没有可以下手的真控制面");
    try {
      process.kill(build.authorityPid, "SIGKILL");
    } catch (error) {
      throw new Error(`控制面已经不在：${(error as Error).message}`);
    }
    await build.settle();
    ctx.trace.record({ kind: "note", name: "killAuthorityDuringBuild", detail: { authorityPid: build.authorityPid, kernelPid: build.kernelPid } });
    // Give the kernel the real shutdown grace before an invariant calls it an orphan.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const orphan = ctx.session.orphanKernels().find((kernel) => kernel.pid === build.kernelPid);
      if (orphan) {
        ctx.trace.note(`控制面死后 kernel ${orphan.pid} 还在跑（孤儿进程）`);
        return;
      }
      await sleep(100);
    }
    ctx.trace.note("控制面死后 kernel 也跟着退了，这轮没留下孤儿");
  },
  recover: async (ctx) => {
    // A one-shot authority has no in-process recovery, but the leftover kernel
    // is a real leak: the slice cleans it up so later iterations are honest.
    let cleaned = 0;
    for (const kernel of ctx.session.kernels()) {
      if (!kernel.orphan) continue;
      ctx.session.killKernel(kernel.pid, "SIGKILL");
      cleaned += 1;
    }
    if (cleaned) ctx.trace.note(`清理了 ${cleaned} 个孤儿 kernel 进程`);
    ctx.session.disarmFault("killAuthorityDuringBuild");
  },
};

export const reifyFaultDefinitions: ReifyFaultDefinition[] = [
  killKernelDuringBuild,
  pauseKernelDuringBuild,
  killAuthorityDuringBuild,
];
