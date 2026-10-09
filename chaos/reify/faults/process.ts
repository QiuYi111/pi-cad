/** Process faults: kill, pause and restart the real kernel, authority, runtime and Prime processes. */

import type { FaultBuild } from "./shared.ts";
import fc from "fast-check";
import { InvariantViolation } from "../../types.ts";
import { FaultNotApplicable } from "../types.ts";
import type { Params, ReifyFaultDefinition } from "../types.ts";
import { ReifyPrimeRuntime } from "../prime.ts";
import { resolveProviderSelection } from "../inspect.ts";
import { processTree, sleep } from "../../support/process.ts";
import {
  commandAvailable,
  RECOVERY_BUDGET_MS,
  faultConversationIndex,
  conversationOf,
  runViewOrThrow,
  buildAllowed,
  buildableRunPrecondition,
  startFaultBuild,
  settleWithin,
  proveRecovery,
  describeKernel,
  errorMessageOf,
} from "./shared.ts";

/** SIGKILL the real CAD kernel while it is inside a real build. */
export const killKernelDuringBuild: ReifyFaultDefinition = {
  name: "killKernelDuringBuild",
  description: "真 model-build 途中 SIGKILL 真 cadctl kernel",
  arbitrary: fc.record({ conversationIndex: fc.integer({ min: 0, max: 1 }) }),
  describe: (params) => `killKernelDuringBuild(conv#${params.conversationIndex})`,
  precondition: (ctx) => buildableRunPrecondition(ctx),
  inject: async (ctx) => {
    // Precondition, injection and recovery all use the generated index.
    const build = await startFaultBuild(ctx, "killKernelDuringBuild", faultConversationIndex(ctx));
    ctx.session.killKernel(build.kernelPid, "SIGKILL");
    ctx.trace.record({ kind: "note", name: "killKernelDuringBuild", detail: { detail: describeKernel(build) } });
    const settled = await settleWithin(build, 45_000);
    if (settled) {
      ctx.trace.note(`kernel 被杀后控制面报：${errorMessageOf(settled)}`);
    } else {
      // The control plane never noticed its kernel died, so the harness stops
      // the stuck request itself; recover() only judges whether a fresh build works.
      ctx.trace.note("kernel 被杀 45s 后控制面还没反应，由 harness 一起停掉 kernel 和控制面");
      ctx.session.killKernel(build.kernelPid, "SIGKILL");
      build.killOwner("SIGKILL");
    }
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "killKernelDuringBuild", faultConversationIndex(ctx));
    ctx.session.disarmFault("killKernelDuringBuild");
  },
};

/** SIGSTOP the real kernel mid-build, then let it run again with SIGCONT. */
export const pauseKernelDuringBuild: ReifyFaultDefinition = {
  name: "pauseKernelDuringBuild",
  description: "真 build 途中 SIGSTOP/SIGCONT 真 kernel",
  arbitrary: fc.constant<Params>({}),
  describe: () => "pauseKernelDuringBuild",
  precondition: (ctx) => buildableRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "pauseKernelDuringBuild");
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

/** SIGKILL the one-shot authority process while its warm kernel is mid-build. */
export const killAuthorityDuringBuild: ReifyFaultDefinition = {
  name: "killAuthorityDuringBuild",
  description: "真 build 途中 SIGKILL 真控制面进程（每条请求一个进程）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killAuthorityDuringBuild",
  precondition: async (ctx) => {
    if (ctx.session.attachedRuntime) {
      return { applicable: false, reason: "这一轮直连常驻 runtime，没有一次性控制面进程；runtime 生命周期故障用 killRuntimeDuringBuild" };
    }
    return { applicable: true };
  },
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "killAuthorityDuringBuild");
    try {
      build.killOwner("SIGKILL");
    } catch (error) {
      throw new Error(`控制面已经不在：${(error as Error).message}`);
    }
    await build.settle();
    ctx.trace.record({ kind: "note", name: "killAuthorityDuringBuild", detail: { detail: describeKernel(build) } });
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

/** SIGSTOP the one-shot authority mid-build, then SIGCONT and prove recovery. */
export const pauseAuthorityDuringBuild: ReifyFaultDefinition = {
  name: "pauseAuthorityDuringBuild",
  description: "真 build 途中 SIGSTOP/SIGCONT 真控制面进程（慢/hang 的控制面）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "pauseAuthorityDuringBuild",
  precondition: async (ctx) =>
    ctx.session.attachedRuntime
      ? { applicable: false, reason: "这一轮直连常驻 runtime；runtime 暂停用 pauseRuntimeDuringBuild" }
      : { applicable: true },
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "pauseAuthorityDuringBuild");
    build.killOwner("SIGSTOP");
    ctx.session.armedFaults.set("pauseAuthorityDuringBuild", { build });
    await sleep(Number(process.env.CHAOS_REIFY_PAUSE_MS ?? 3_000));
    ctx.trace.note(`控制面暂停中（${describeKernel(build)}），真请求还没结束`);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("pauseAuthorityDuringBuild") as { build: FaultBuild } | undefined;
    ctx.session.disarmFault("pauseAuthorityDuringBuild");
    if (!armed) return;
    armed.build.killOwner("SIGCONT");
    const settled = await settleWithin(armed.build, RECOVERY_BUDGET_MS);
    if (!settled) {
      throw new InvariantViolation("recovery-convergence", "控制面恢复运行后真 build 仍没有结束", { ownerPid: armed.build.ownerPid });
    }
    ctx.trace.note(`控制面恢复运行后请求结束（signal=${settled.signal ?? settled.code}）`);
    await proveRecovery(ctx, "pauseAuthorityDuringBuild");
  },
};

/** Kill the warm kernel while it is idle, then require the next real build to work. */
export const killIdleKernel: ReifyFaultDefinition = {
  name: "killIdleKernel",
  description: "空闲时 SIGKILL 真 warm kernel，之后真 build 必须还能起来",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killIdleKernel",
  precondition: async (ctx) => {
    const owned = ctx.session.kernels().filter((kernel) => kernel.ownerPid !== null && !kernel.orphan);
    if (!owned.length) return { applicable: false, reason: "没有活着的 warm kernel（这一轮还没真 build 过）" };
    if (!(await buildAllowed(ctx, conversationOf(ctx, 0)))) {
      return { applicable: false, reason: "当前阶段不允许 model.build，恢复没法由真 build 证明" };
    }
    return { applicable: true, evidence: { kernels: owned.map((kernel) => kernel.pid) } };
  },
  inject: async (ctx) => {
    const owned = ctx.session.kernels().filter((kernel) => kernel.ownerPid !== null && !kernel.orphan);
    if (!owned.length) throw new FaultNotApplicable("warm kernel 在注入前就没了");
    for (const kernel of owned) ctx.session.killKernel(kernel.pid, "SIGKILL");
    ctx.session.armFault("killIdleKernel");
    ctx.trace.record({ kind: "note", name: "killIdleKernel", detail: { kernels: owned.map((kernel) => kernel.pid) } });
    await sleep(300);
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "killIdleKernel");
    ctx.session.disarmFault("killIdleKernel");
  },
};

/** Kill the forked child inside the kernel tree, leaving the wrapper alive. */
export const killKernelChild: ReifyFaultDefinition = {
  name: "killKernelChild",
  description: "真 build 途中 SIGKILL kernel 树里的子进程（child 先死，owner 还在）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killKernelChild",
  precondition: (ctx) => buildableRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "killKernelChild");
    // `startFaultBuild` only returns once the request really runs in the
    // forked child, so this kills the build child and leaves the warm kernel
    // itself alive -- which is the whole point of the fault.
    const child = build.buildChildPid;
    ctx.session.killKernel(child, "SIGKILL");
    ctx.trace.record({ kind: "note", name: "killKernelChild", detail: { child, detail: describeKernel(build) } });
    const settled = await settleWithin(build, 45_000);
    ctx.trace.note(settled ? `kernel 子进程死后控制面报：${errorMessageOf(settled)}` : "kernel 子进程死后 45s 控制面还没有反应");
    ctx.session.armedFaults.set("killKernelChild", { kernelPid: build.kernelPid });
  },
  recover: async (ctx) => {
    // The wrapper can outlive the child we killed; that leftover is our
    // damage, so clear the whole tree before judging the product.
    const armed = ctx.session.armedFaults.get("killKernelChild") as { kernelPid: number } | undefined;
    if (armed) {
      const tree = processTree(armed.kernelPid);
      for (const pid of tree) ctx.session.killKernel(pid, "SIGKILL");
      ctx.trace.note(`清掉 kernel ${armed.kernelPid} 的残留进程树（${tree.length} 个）`);
    }
    await proveRecovery(ctx, "killKernelChild");
    ctx.session.disarmFault("killKernelChild");
  },
};

/** Kill the long-lived runtime (the real Desktop/Prime backend) mid-build. */
export const killRuntimeDuringBuild: ReifyFaultDefinition = {
  name: "killRuntimeDuringBuild",
  description: "真 build 途中 SIGKILL 常驻 runtime（Desktop/Prime 连的真后端）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killRuntimeDuringBuild",
  precondition: async (ctx) =>
    ctx.session.attachedRuntime ? { applicable: true } : { applicable: false, reason: "这一轮没有挂常驻 runtime（用 --runtime 驱动）" },
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "killRuntimeDuringBuild");
    if (!build.viaRuntime) throw new FaultNotApplicable("这条 build 不是 runtime 服务的");
    build.killOwner("SIGKILL");
    await sleep(500);
    ctx.trace.record({ kind: "note", name: "killRuntimeDuringBuild", detail: { detail: describeKernel(build) } });
    const settled = await settleWithin(build, 20_000);
    ctx.trace.note(settled ? `runtime 被杀后请求结束：${errorMessageOf(settled)}` : "runtime 被杀后请求还挂着（socket 没断）");
  },
  recover: async (ctx) => {
    const runtime = ctx.session.attachedRuntime;
    if (!runtime) throw new Error("runtime 句柄丢了，没法恢复");
    const info = await runtime.start();
    ctx.session.registerAuthorityPid(info.pid, "runtime");
    ctx.trace.note(`runtime 重新起来 pid=${info.pid}`);
    await proveRecovery(ctx, "killRuntimeDuringBuild");
    ctx.session.disarmFault("killRuntimeDuringBuild");
  },
};

/**
 * SIGSTOP the long-lived runtime mid-build, then let it run again.
 *
 * The freeze window is bounded inside `inject` on purpose. The runtime is the
 * process every request goes through, so leaving it SIGSTOPped while the rest
 * of the sequence runs makes each following request hang on the harness's own
 * socket timeout and then read as "the product never converged" — a failure
 * the harness caused itself, not a product finding. A bounded window is also
 * reproducible: its length no longer depends on how many commands the
 * generator happens to append after the fault.
 */
export const pauseRuntimeDuringBuild: ReifyFaultDefinition = {
  name: "pauseRuntimeDuringBuild",
  description: "真 build 途中 SIGSTOP/SIGCONT 常驻 runtime",
  arbitrary: fc.constant<Params>({}),
  describe: () => "pauseRuntimeDuringBuild",
  precondition: async (ctx) =>
    ctx.session.attachedRuntime ? { applicable: true } : { applicable: false, reason: "这一轮没有挂常驻 runtime（用 --runtime 驱动）" },
  inject: async (ctx) => {
    const build = await startFaultBuild(ctx, "pauseRuntimeDuringBuild");
    build.killOwner("SIGSTOP");
    const windowMs = Number(process.env.CHAOS_REIFY_PAUSE_MS ?? 3_000);
    await sleep(windowMs);
    ctx.trace.note(`runtime 被 SIGSTOP ${windowMs}ms 期间真请求没有应答（${describeKernel(build)}）`);
    build.killOwner("SIGCONT");
    ctx.session.armedFaults.set("pauseRuntimeDuringBuild", { build });
    const settled = await settleWithin(build, RECOVERY_BUDGET_MS);
    ctx.trace.note(
      settled ? `runtime 恢复运行后原请求结束（${settled.signal ?? settled.code}）` : "runtime 恢复运行后原请求仍未结束",
    );
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("pauseRuntimeDuringBuild") as { build: FaultBuild } | undefined;
    ctx.session.disarmFault("pauseRuntimeDuringBuild");
    // SIGCONT already happened in inject; this is an idempotent safety net.
    armed?.build.killOwner("SIGCONT");
    await proveRecovery(ctx, "pauseRuntimeDuringBuild");
  },
};

/** Stop and immediately start the runtime while a build is still in flight. */
export const restartRuntimeDuringBuild: ReifyFaultDefinition = {
  name: "restartRuntimeDuringBuild",
  description: "真 build 途中重启常驻 runtime（旧进程可能还没退干净）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "restartRuntimeDuringBuild",
  precondition: async (ctx) =>
    ctx.session.attachedRuntime ? { applicable: true } : { applicable: false, reason: "这一轮没有挂常驻 runtime（用 --runtime 驱动）" },
  inject: async (ctx) => {
    const runtime = ctx.session.attachedRuntime!;
    const build = await startFaultBuild(ctx, "restartRuntimeDuringBuild");
    const oldPid = runtime.pid;
    // No awaited drain: the old process is still exiting while the new one
    // starts, which is exactly the restart race the product has to survive.
    const restarted = await runtime.restart();
    ctx.session.registerAuthorityPid(restarted.pid, "runtime");
    ctx.trace.record({
      kind: "note",
      name: "restartRuntimeDuringBuild",
      detail: { oldPid, newPid: restarted.pid, closingPid: runtime.closingPid ?? null, detail: describeKernel(build) },
    });
    const settled = await settleWithin(build, 20_000);
    ctx.trace.note(settled ? `重启后原请求结束：${errorMessageOf(settled)}` : "重启后原请求还挂着");
  },
  recover: async (ctx) => {
    await proveRecovery(ctx, "restartRuntimeDuringBuild");
    ctx.session.disarmFault("restartRuntimeDuringBuild");
  },
};

/** Kill a real Prime runtime process, then require a fresh one to answer. */
export const killPrimeRuntime: ReifyFaultDefinition = {
  name: "killPrimeRuntime",
  description: "SIGKILL 真 Prime runtime 进程（prime-cad-sidecar --mode rpc），之后必须能再起",
  arbitrary: fc.constant<Params>({}),
  describe: () => "killPrimeRuntime",
  precondition: async () => {
    if (!ReifyPrimeRuntime.available()) return { applicable: false, reason: "本机没有可解析的 prime-agent checkout" };
    const selection = resolveProviderSelection();
    if (selection.provider === "unknown" || selection.model === "unknown") {
      return { applicable: false, reason: "读不到真 provider / model 选择，起了 Prime 也没意义" };
    }
    return { applicable: true, evidence: { provider: selection.provider, model: selection.model } };
  },
  inject: async (ctx) => {
    const selection = resolveProviderSelection();
    const prime = await ReifyPrimeRuntime.start({
      project: ctx.session.project,
      env: ctx.session.env,
      provider: selection.provider,
      model: selection.model,
      thinking: selection.thinking ?? "low",
    });
    ctx.session.armedFaults.set("killPrimeRuntime", { prime, pid: prime.pid });
    try {
      process.kill(prime.pid, "SIGKILL");
    } catch (error) {
      throw new Error(`Prime runtime 已经不在：${(error as Error).message}`);
    }
    await sleep(1_000);
    ctx.trace.record({ kind: "note", name: "killPrimeRuntime", detail: { pid: prime.pid, alive: prime.alive } });
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("killPrimeRuntime") as { prime: ReifyPrimeRuntime } | undefined;
    ctx.session.disarmFault("killPrimeRuntime");
    await armed?.prime.close().catch(() => undefined);
    const selection = resolveProviderSelection();
    const fresh = await ReifyPrimeRuntime.start({
      project: ctx.session.project,
      env: ctx.session.env,
      provider: selection.provider,
      model: selection.model,
      thinking: selection.thinking ?? "low",
    });
    const sessionId = fresh.current?.sessionId ?? null;
    ctx.trace.note(`Prime runtime 重新起起来了 pid=${fresh.pid} sessionId=${sessionId ?? "无"}`);
    await fresh.close();
  },
};

/**
 * CPU pressure from a mature external tool. There is no built-in stressor on
 * this machine, so the fault honestly reports NotApplicable instead of
 * pretending it applied.
 */
export const cpuPressure: ReifyFaultDefinition = {
  name: "cpuPressure",
  description: "用真 stress-ng 制造 CPU 压力，再要求真 build 还能成功",
  arbitrary: fc.constant<Params>({}),
  describe: () => "cpuPressure",
  precondition: async (ctx) => {
    if (!(await commandAvailable("stress-ng"))) {
      return { applicable: false, reason: "本机没有 stress-ng；不自研压测工具" };
    }
    const conversation = conversationOf(ctx);
    // A failed state read is thrown, not reported as "no active run".
    const view = await runViewOrThrow(ctx, conversation);
    if (view.status !== "active") return { applicable: false, reason: `会话 ${conversation} 没有 active run（${view.status ?? "无"}）` };
    return { applicable: true };
  },
  inject: async (ctx) => {
    const seconds = 5;
    const { spawn } = await import("node:child_process");
    const workers = Math.max(1, Math.min(4, Number(process.env.CHAOS_REIFY_CPU_WORKERS ?? 2)));
    const child = spawn("stress-ng", ["--cpu", String(workers), "--timeout", `${seconds}s`, "--quiet"], { stdio: "ignore" });
    ctx.session.armedFaults.set("cpuPressure", { child });
    ctx.session.armFault("cpuPressure");
    ctx.trace.record({ kind: "note", name: "cpuPressure", detail: { workers, seconds, pid: child.pid } });
    await sleep(seconds * 1_000 * 0.5);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("cpuPressure") as { child: { kill: (signal?: NodeJS.Signals) => void } } | undefined;
    ctx.session.disarmFault("cpuPressure");
    armed?.child.kill("SIGKILL");
    await proveRecovery(ctx, "cpuPressure");
  },
};

// ---------------------------------------------------------------------------
// 文件 / 状态 / 时序
// ---------------------------------------------------------------------------

/** Move a run's real state file aside, so the backend really loses it. */
