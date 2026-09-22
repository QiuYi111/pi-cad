import { accessSync, chmodSync, constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import fc from "fast-check";

import { InvariantViolation } from "../types.ts";
import { ReifyPrimeRuntime } from "./prime.ts";
import { resolveProviderSelection } from "./inspect.ts";
import {
  applyCredentialFault,
  credentialSandboxPresent,
  providerFaultsEnabled,
  runTransportFault,
  seedCredentialSandbox,
  transportTarget,
  type CredentialSandbox,
} from "./provider.ts";
import { processTree } from "./session.ts";
import { FaultNotApplicable } from "./types.ts";
import type { FaultPrecondition, Params, ReifyContext, ReifyFaultDefinition } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Is a real external tool on PATH? Used to decide NotApplicable honestly. */
async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${command}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** The slow model keeps the warm kernel busy long enough to be faulted. */
const SLOW_SOURCE = "slow_part.py";
const FAST_SOURCE = "part.py";
/** Real builds and real kernel restarts must finish inside this budget. */
const RECOVERY_BUDGET_MS = Number(process.env.CHAOS_REIFY_RECOVERY_BUDGET_MS ?? 90_000);
/** Each recovery build needs its own output path, otherwise cadctl serves a cache hit. */
let recoveryCounter = 0;
/** Build output paths must differ per conversation and per attempt. */
let buildCounter = 0;

const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

/**
 * The conversation a generated fault param really selects.
 *
 * Every fault that carries `conversationIndex` must use this one value from
 * precondition through injection to recovery. Otherwise the artifact names one
 * object and the fault hits another, and the multi-conversation evidence the
 * artifact carries is not trustworthy.
 */
function faultConversationIndex(ctx: ReifyContext): number {
  return Number(ctx.params.conversationIndex ?? 0);
}

function conversationOf(ctx: ReifyContext, index = faultConversationIndex(ctx)): string {
  return ctx.session.conversation(index);
}

/** The run of one conversation as the real API reports it right now. */
async function runView(ctx: ReifyContext, conversation: string): Promise<{ runId: string | null; status: string | null; phase: string | null }> {
  const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as
    | { runId?: string; status?: string; phase?: string }
    | null;
  return { runId: view?.runId ?? null, status: view?.status ?? null, phase: view?.phase ?? null };
}

/**
 * Read a conversation's real run state, keeping a read failure a failure.
 *
 * The real system answering with an error is never "this fault does not
 * apply": it is thrown here so the runner records `InjectionFailed` (or
 * `RecoveryFailed`) instead of quietly turning a broken state source into a
 * skip.
 */
async function runViewOrThrow(
  ctx: ReifyContext,
  conversation: string,
): Promise<{ runId: string | null; status: string | null; phase: string | null }> {
  try {
    return await runView(ctx, conversation);
  } catch (error) {
    throw new Error(`读不到会话 ${conversation} 的真状态：${(error as Error).message}`);
  }
}

/**
 * Does the run's current phase really allow a build right now?
 *
 * The workflow's own capability list answers this: `cad_build_step` only
 * appears in the phase that grants `model_build`. Asking the product instead
 * of hardcoding a phase name is what keeps the harness from demanding a build
 * in `plan` and calling the refusal "no recovery".
 */
async function capabilityAllowed(ctx: ReifyContext, conversation: string, capability: string): Promise<boolean> {
  // A read failure from the authority is a real failure. Folding it into
  // "this phase does not allow it" would turn a broken state source into a
  // silent NotApplicable, which is exactly what these faults must not do.
  const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as
    | { operations?: { capability?: string }[]; can?: string[] }
    | null;
  if (!view) return false;
  if ((view.operations ?? []).some((operation) => operation.capability === capability)) return true;
  return (view.can ?? []).some((entry) => entry.startsWith(capability));
}

function buildAllowed(ctx: ReifyContext, conversation: string): Promise<boolean> {
  return capabilityAllowed(ctx, conversation, "cad_build_step");
}

function commitAllowed(ctx: ReifyContext, conversation: string): Promise<boolean> {
  return capabilityAllowed(ctx, conversation, "cad_commit");
}

/** The events this conversation's run really accepts right now. */
async function legalTransitions(ctx: ReifyContext, conversation: string): Promise<string[]> {
  const view = (await ctx.session.call("workflow-current", { sessionId: conversation })) as
    | { transitions?: { event?: string }[] }
    | null;
  return (view?.transitions ?? []).map((transition) => String(transition.event ?? "")).filter((event) => event.length > 0);
}

/**
 * A product answer that means "this transition was refused", as opposed to
 * "the runtime died while the request was in flight". Only the refusal means
 * no real transition-versus-restart race happened.
 */
const TRANSITION_DENIAL =
  /illegal workflow transition|cannot transition run in status|phase obligations remain unmet|transition requires|transition forbids/;

function transitionDeniedByProduct(message: string): boolean {
  return TRANSITION_DENIAL.test(message);
}

/** Real-state precondition: is there an active run that may build right now? */
async function activeRunPrecondition(
  ctx: ReifyContext,
  conversationIndex = faultConversationIndex(ctx),
  options: { requireBuild?: boolean } = {},
): Promise<FaultPrecondition> {
  const conversation = ctx.session.conversation(conversationIndex);
  // Only a successful read that says "no active run" may be NotApplicable.
  const view = await runViewOrThrow(ctx, conversation);
  if (view.status !== "active") {
    return { applicable: false, reason: `会话 ${conversation} 没有 active run（${view.status ?? "无"}）` };
  }
  if (options.requireBuild && !(await buildAllowed(ctx, conversation))) {
    return { applicable: false, reason: `会话 ${conversation} 当前阶段 ${view.phase ?? "?"} 不允许 model.build` };
  }
  return { applicable: true, evidence: { conversation, runId: view.runId, phase: view.phase } };
}

/** Precondition for the faults that really build: the run must be in `cook`. */
function buildableRunPrecondition(ctx: ReifyContext, conversationIndex?: number): Promise<FaultPrecondition> {
  return activeRunPrecondition(ctx, conversationIndex ?? faultConversationIndex(ctx), { requireBuild: true });
}

interface FaultBuild {
  conversation: string;
  /** The run this build really belongs to, so the artifact names the object hit. */
  runId: string | null;
  /** The process that owns the CAD kernel: a one-shot authority, or the runtime. */
  ownerPid: number;
  kernelPid: number;
  /** The forked child that really runs the request inside the warm kernel. */
  buildChildPid: number;
  viaRuntime: boolean;
  settle: () => Promise<{ code: number | null; signal: string | null; stdout: string }>;
  /** Really kill the process serving this build. */
  killOwner: (signal?: NodeJS.Signals) => void;
}

/**
 * Start a real slow `model-build` and wait until its owner really holds a live
 * CAD kernel that is really inside the build. Throws FaultNotApplicable when
 * the system cannot reach that state, so a fault never invents a failure the
 * product did not have.
 *
 * The kernel exists as soon as it is spawned, but the worker imports
 * build123d/OCC (seconds) before it forks the child that runs a request. Every
 * `*DuringBuild` fault has to land on the real build, so this waits for that
 * forked child: stopping a kernel that is still warming up is a different
 * fault, and the worker has not bound itself to its owner yet either.
 */
async function startFaultBuild(ctx: ReifyContext, fault: string, conversationIndex = faultConversationIndex(ctx)): Promise<FaultBuild> {
  const conversation = conversationOf(ctx, conversationIndex);
  // The index the generator chose is the index used all the way through, so a
  // build generated for conversation 1 can never land on conversation 0.
  const view = await runViewOrThrow(ctx, conversation);
  if (view.status !== "active") {
    throw new FaultNotApplicable(`会话 ${conversation} 没有 active run（${view.status ?? "无"}）`, { conversation });
  }
  if (!(await buildAllowed(ctx, conversation))) {
    throw new FaultNotApplicable(`会话 ${conversation} 当前阶段 ${view.phase ?? "?"} 不允许 model.build`, { conversation, phase: view.phase });
  }
  const live = ctx.session.startBuild("model-build", {
    source: SLOW_SOURCE,
    output: `build/chaos-${++buildCounter}-${conversation}.step`,
    validation: "fast",
    sessionId: conversation,
  });
  const kernel = await Promise.race([
    ctx.session.waitForOwnedKernel(live.ownerPid, 30_000),
    live.settle.then(() => null),
  ]);
  if (!kernel) {
    throw new FaultNotApplicable("没等到真的 kernel 进程", { conversation, ownerPid: live.ownerPid });
  }
  const buildChildPid = await ctx.session.waitForBuildChild(kernel.pid);
  if (buildChildPid === null) {
    throw new FaultNotApplicable("kernel 起了但没有进入真 build（没等到 build 子进程）", {
      conversation,
      ownerPid: live.ownerPid,
      kernelPid: kernel.pid,
    });
  }
  ctx.session.armFault(fault);
  return {
    conversation,
    runId: view.runId,
    ownerPid: live.ownerPid,
    kernelPid: kernel.pid,
    buildChildPid,
    viaRuntime: live.viaRuntime,
    settle: () => live.settle,
    killOwner: (signal: NodeJS.Signals = "SIGKILL") => live.kill(signal),
  };
}

/** Wait for a real request to settle, without letting a hang eat the whole run. */
async function settleWithin(build: FaultBuild, timeoutMs: number): Promise<{ code: number | null; signal: string | null; stdout: string } | null> {
  return await Promise.race([build.settle(), sleep(timeoutMs).then(() => null)]);
}

/** A recovered system answers another real build with a real STEP artifact. */
async function proveRecovery(ctx: ReifyContext, after: string, conversationIndex = faultConversationIndex(ctx)): Promise<void> {
  const conversation = conversationOf(ctx, conversationIndex);
  const view = await runViewOrThrow(ctx, conversation);
  if (view.status !== "active") {
    ctx.trace.note(`${after} 之后 run 状态是 ${view.status ?? "无"}，不再要求重建`);
    return;
  }
  if (!(await buildAllowed(ctx, conversation))) {
    // Recovery is only owed a build when the run really may build. Demanding
    // one in `plan` would be the harness inventing a failure.
    ctx.trace.note(`${after} 之后 run 在 ${view.phase ?? "?"} 阶段，不允许 model.build，不要求重建`);
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

/** How the fault handle names itself in a trace note. */
function describeKernel(build: FaultBuild): string {
  return `conv=${build.conversation} run=${build.runId ?? "无"} kernel=${build.kernelPid} build=${build.buildChildPid} owner=${build.ownerPid}${
    build.viaRuntime ? "(runtime)" : "(authority)"
  }`;
}

// ---------------------------------------------------------------------------
// 进程 / 资源：kernel、控制面、runtime、Prime
// ---------------------------------------------------------------------------

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
export const missingRunStateFile: ReifyFaultDefinition = {
  name: "missingRunStateFile",
  description: "把真 run 的 state.json 临时挪走，看真后端怎么应对缺文件",
  arbitrary: fc.constant<Params>({}),
  describe: () => "missingRunStateFile",
  precondition: (ctx) => buildableRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const conversation = conversationOf(ctx);
    const view = await runView(ctx, conversation);
    if (view.status !== "active" || !view.runId) {
      throw new FaultNotApplicable(`会话没有 active run（${view.status ?? "无"}）`, { conversation });
    }
    const dir = ctx.session.runDir(view.runId);
    const file = join(dir, "state.json");
    if (!existsSync(file)) throw new FaultNotApplicable("run state.json 本来就不在", { runId: view.runId });
    const hidden = `${file}.chaos-hidden`;
    renameSync(file, hidden);
    ctx.session.markDamagedRun(view.runId);
    ctx.session.armedFaults.set("missingRunStateFile", { file, hidden, runId: view.runId });
    ctx.session.armFault("missingRunStateFile");
    ctx.trace.record({ kind: "note", name: "missingRunStateFile", detail: { runId: view.runId, file } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("missingRunStateFile") as { file: string; hidden: string; runId: string } | undefined;
    ctx.session.disarmFault("missingRunStateFile");
    if (armed) {
      if (existsSync(armed.hidden) && !existsSync(armed.file)) renameSync(armed.hidden, armed.file);
      ctx.session.unmarkDamagedRun(armed.runId);
      ctx.trace.note(`run ${armed.runId} 的 state.json 放回去了`);
    }
    await proveRecovery(ctx, "missingRunStateFile");
  },
};

/** Make a run's real state file unreadable, the way a permissions fault would. */
export const unreadableRunStateFile: ReifyFaultDefinition = {
  name: "unreadableRunStateFile",
  description: "把真 run 的 state.json 改成不可读，看真后端怎么应对",
  arbitrary: fc.constant<Params>({}),
  describe: () => "unreadableRunStateFile",
  precondition: async (ctx) =>
    process.getuid?.() === 0
      ? { applicable: false, reason: "root 无视文件权限，chmod 造不出「读不到」" }
      : await activeRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const view = await runView(ctx, conversationOf(ctx));
    if (view.status !== "active" || !view.runId) throw new FaultNotApplicable(`会话没有 active run（${view.status ?? "无"}）`);
    const file = join(ctx.session.runDir(view.runId), "state.json");
    if (!existsSync(file)) throw new FaultNotApplicable("run state.json 本来就不在");
    chmodSync(file, 0o000);
    ctx.session.markDamagedRun(view.runId);
    ctx.session.armedFaults.set("unreadableRunStateFile", { file, runId: view.runId });
    ctx.session.armFault("unreadableRunStateFile");
    ctx.trace.record({ kind: "note", name: "unreadableRunStateFile", detail: { runId: view.runId, file } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("unreadableRunStateFile") as { file: string; runId: string } | undefined;
    ctx.session.disarmFault("unreadableRunStateFile");
    if (armed) {
      if (existsSync(armed.file)) chmodSync(armed.file, 0o644);
      ctx.session.unmarkDamagedRun(armed.runId);
      ctx.trace.note(`run ${armed.runId} 的 state.json 权限恢复了`);
    }
    await proveRecovery(ctx, "unreadableRunStateFile");
  },
};

/** Cut a state file in half, the way an interrupted write would. */
export const partialStateWrite: ReifyFaultDefinition = {
  name: "partialStateWrite",
  description: "把真 run 的 state.json 截成半截（模拟写一半断电）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "partialStateWrite",
  precondition: async (ctx) => {
    const base = await buildableRunPrecondition(ctx, 0);
    if (!base.applicable) return base;
    const view = await runView(ctx, conversationOf(ctx));
    if (view.status !== "active" || !view.runId) {
      return { applicable: false, reason: `会话没有 active run（${view.status ?? "无"}）` };
    }
    const file = join(ctx.session.runDir(view.runId), "state.json");
    if (!existsSync(file)) return { applicable: false, reason: "run state.json 本来就不在" };
    // "写一半断电"要求这个文件本来就能读写。另一个 fault（比如
    // unreadableRunStateFile）刚把它改成读不到时，硬写只会造出 harness 自己的
    // EACCES，再被记成一次假的产品失败。这里明说「不适用」。
    try {
      accessSync(file, constants.R_OK | constants.W_OK);
    } catch {
      return { applicable: false, reason: "run state.json 现在读不了或写不了（多半是 unreadableRunStateFile 还挂着）" };
    }
    return base;
  },
  inject: async (ctx) => {
    const view = await runView(ctx, conversationOf(ctx));
    if (view.status !== "active" || !view.runId) throw new FaultNotApplicable(`会话没有 active run（${view.status ?? "无"}）`);
    const file = join(ctx.session.runDir(view.runId), "state.json");
    if (!existsSync(file)) throw new FaultNotApplicable("run state.json 本来就不在");
    // 截两次会把第一次留下的完整原件覆盖成半截，recover 之后文件再也回不去，
    // 那是 harness 自己造的损坏，不是产品问题。
    if (existsSync(`${file}.chaos-original`)) {
      throw new FaultNotApplicable("这个 run 的 state.json 已经截过一次，原件还在 .chaos-original");
    }
    const original = readFileSync(file);
    writeFileSync(`${file}.chaos-original`, original);
    writeFileSync(file, original.subarray(0, Math.max(1, Math.floor(original.length / 2))));
    ctx.session.markDamagedRun(view.runId);
    ctx.session.armedFaults.set("partialStateWrite", { file, runId: view.runId });
    ctx.session.armFault("partialStateWrite");
    ctx.trace.record({ kind: "note", name: "partialStateWrite", detail: { runId: view.runId, bytes: original.length } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("partialStateWrite") as { file: string; runId: string } | undefined;
    ctx.session.disarmFault("partialStateWrite");
    if (armed) {
      const backup = `${armed.file}.chaos-original`;
      if (existsSync(backup)) {
        copyFileSync(backup, armed.file);
        rmSync(backup, { force: true });
      }
      ctx.session.unmarkDamagedRun(armed.runId);
      ctx.trace.note(`run ${armed.runId} 的 state.json 恢复完整`);
    }
    await proveRecovery(ctx, "partialStateWrite");
  },
};

/** Delete the Desktop-facing status projection so the real authority must rewrite it. */
export const missingDesktopProjection: ReifyFaultDefinition = {
  name: "missingDesktopProjection",
  description: "删掉真 .pi-cad/status.json 投影，之后真请求必须把它写回来",
  arbitrary: fc.constant<Params>({}),
  describe: () => "missingDesktopProjection",
  inject: async (ctx) => {
    const file = join(ctx.session.project, ".pi-cad", "status.json");
    if (!existsSync(file)) throw new FaultNotApplicable("这一轮还没有 Desktop 投影可删");
    ctx.session.markDamagedProjection();
    const payload = readFileSync(file);
    ctx.session.armedFaults.set("missingDesktopProjection", { file, payload });
    ctx.session.armFault("missingDesktopProjection");
    rmSync(file, { force: true });
    ctx.trace.record({ kind: "note", name: "missingDesktopProjection", detail: { file, bytes: payload.length } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("missingDesktopProjection") as { file: string } | undefined;
    ctx.session.disarmFault("missingDesktopProjection");
    ctx.session.unmarkDamagedProjection();
    // The projection belongs to the long-lived runtime, the backend the Desktop
    // talks to. The runner recovers faults in reverse injection order, so a
    // round where another fault SIGKILLed that runtime recovers *this* fault
    // while it is still down; `session.call` then silently falls back to a
    // one-shot authority, which never owns `.pi-cad/status.json`, and the check
    // below would blame the product for a projection the harness never asked
    // the right process to write. Bring the runtime back first — the same real
    // restart the runtime faults do in their own recover — and keep the check
    // on the surface that really owns it.
    const runtime = ctx.session.attachedRuntime;
    if (runtime && !runtime.alive) {
      const info = await runtime.start();
      ctx.session.registerAuthorityPid(info.pid, "runtime");
      ctx.trace.note(`Desktop 投影要常驻 runtime 才算数：先把它重新起来 pid=${info.pid}`);
    }
    // One real request makes the real authority rewrite its own projection.
    await ctx.session.call("workflow-current", { sessionId: conversationOf(ctx) });
    if (!existsSync(armed?.file ?? "")) {
      throw new InvariantViolation("recovery-convergence", "真 authority 没有把 .pi-cad/status.json 写回来", { file: armed?.file });
    }
    ctx.trace.note("真 authority 已把 Desktop 投影写回来");
  },
};

// ---------------------------------------------------------------------------
// Provider / OAuth
// ---------------------------------------------------------------------------

/** A chaos-owned copy of the real credential store, shared by provider faults. */
function providerSandbox(ctx: ReifyContext): CredentialSandbox {
  const existing = ctx.session.armedFaults.get("__providerSandbox") as CredentialSandbox | undefined;
  if (existing) return existing;
  const sandbox = seedCredentialSandbox(ctx.session);
  ctx.session.armedFaults.set("__providerSandbox", sandbox);
  return sandbox;
}

/**
 * Only pass a real override. Pushing the placeholder "unknown" through would
 * make the resolver treat it as a real selection and never read the machine's
 * own settings.
 */
function providerSelection(): { provider?: string; model?: string } {
  const override: { provider?: string; model?: string } = {};
  if (process.env.CHAOS_REIFY_PROVIDER) override.provider = process.env.CHAOS_REIFY_PROVIDER;
  if (process.env.CHAOS_REIFY_MODEL) override.model = process.env.CHAOS_REIFY_MODEL;
  return override;
}

async function resolveProviderForFault(
  ctx: ReifyContext,
): Promise<{ selection: { provider: string; model: string }; described: { present: boolean; hasCredentials: boolean; expired: boolean | null } } | null> {
  const cached = await ctx.session.armedFaults.get("__providerSelection");
  if (cached) {
    return cached as { selection: { provider: string; model: string }; described: { present: boolean; hasCredentials: boolean; expired: boolean | null } };
  }
  const { boundary: observed, described } = await (await import("./provider.ts")).observeCredential(
    providerSandbox(ctx),
    providerSelection(),
  );
  if (observed.selection.provider === "unknown" || !described.present) return null;
  const resolved = { selection: { provider: observed.selection.provider, model: observed.selection.model }, described };
  ctx.session.armedFaults.set("__providerSelection", resolved);
  return resolved;
}

function credentialFault(name: string, fault: "expire" | "drop" | "blank"): ReifyFaultDefinition {
  return {
    name,
    description:
      fault === "expire"
        ? "把真 schema 的 OAuth 凭证改成已过期，看真读取代码怎么判"
        : fault === "drop"
          ? "把选中 provider 的凭证从真 schema 副本里删掉"
          : "把选中 provider 的凭证 secret 清空",
    arbitrary: fc.constant<Params>({}),
    describe: () => name,
    precondition: async (ctx) => {
      const sandbox = providerSandbox(ctx);
      if (!credentialSandboxPresent(sandbox)) return { applicable: false, reason: "本机没有真 credentials（~/.prime/agent/auth.json）" };
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) return { applicable: false, reason: "凭证副本里没有可打的 provider（读不到选择或没这条凭证）" };
      return { applicable: true, evidence: { dir: sandbox.dir, provider: resolved.selection.provider, files: sandbox.files } };
    },
    inject: async (ctx) => {
      const sandbox = providerSandbox(ctx);
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) throw new FaultNotApplicable("凭证副本里没有可打的 provider");
      const { selection, described: before } = resolved;
      const result = await applyCredentialFault(sandbox, selection, fault);
      // Recovery must land back on exactly the state we started from, even if
      // the machine's own credential was already unusual.
      ctx.session.armedFaults.set(name, { sandbox, selection, before });
      ctx.session.armFault(name);
      ctx.trace.record({ kind: "note", name, detail: { provider: result.provider, before: result.before, after: result.after } });
    },
    recover: async (ctx) => {
      const armed = ctx.session.armedFaults.get(name) as
        | { sandbox: CredentialSandbox; selection: { provider: string; model: string }; before: { present: boolean; hasCredentials: boolean; expired: boolean | null } }
        | undefined;
      ctx.session.disarmFault(name);
      if (!armed) return;
      const { restoreCredentialSandbox, observeCredential } = await import("./provider.ts");
      restoreCredentialSandbox(armed.sandbox);
      const back = await observeCredential(armed.sandbox, armed.selection);
      if (JSON.stringify(back.described) !== JSON.stringify(armed.before)) {
        throw new InvariantViolation("recovery-convergence", `${name} 之后凭证没有回到原来的状态`, {
          provider: armed.selection.provider,
          before: armed.before,
          after: back.described,
        });
      }
      ctx.trace.note(`凭证副本已还原：${armed.selection.provider} hasCredentials=${back.described.hasCredentials}`);
    },
  };
}

/**
 * A transport fault only counts as injected when the client really saw the
 * thing we meant to inject. "Returned 200 anyway" is a failed injection, not a
 * passing step.
 */
const CREDENTIAL_FAULT_NAMES = ["providerCredentialExpired", "providerCredentialDropped", "providerCredentialBlanked"];

/** The credential fault this round is still holding, if any. */
function credentialFaultArmed(ctx: ReifyContext): string | null {
  return ctx.session.activeFaults.find((name) => CREDENTIAL_FAULT_NAMES.includes(name)) ?? null;
}

/**
 * A real provider refusing the credential: 401 / 403. This is the only
 * transport-probe answer a credential fault is allowed to explain away.
 */
const AUTH_REJECTION_STATUSES = new Set([401, 403]);

/**
 * Does an already-executed transport probe failure really belong to the
 * credential fault armed in this round?
 *
 * Only when the real provider answered with an explicit auth rejection
 * (401/403) does the probe failure say "the credential is broken", which is
 * exactly what the credential fault did -- and never a transport finding.
 * Then, and only then, it is honestly NotApplicable. Everything else the
 * probe really saw (a 200 that arrived too fast, a wrong status code, a hang
 * that never hung) stays a real InjectionFailed, so a credential fault armed
 * nearby can never launder a real transport failure into "did not apply".
 */
export function credentialAuthRejection(
  result: { status: number | null; error?: string },
  credentialFault: string | null,
): string | null {
  if (!credentialFault) return null;
  if (result.status === null || !AUTH_REJECTION_STATUSES.has(result.status)) return null;
  return `本轮挂着凭证故障 ${credentialFault}，真 provider 明确拒了这个凭证（status=${result.status}），传输探针打不实；这是凭证故障自己的后果，不是传输故障`;
}

function assertTransportFaultLanded(
  name: string,
  plan: { mode: "latency" | "hang" | "reset" | "truncate" | "status"; delayMs?: number; status?: number },
  result: { status: number | null; ok: boolean; ms: number; error?: string },
): void {
  const failed = (why: string): never => {
    throw new Error(`${name} 没打上：${why}`);
  };
  switch (plan.mode) {
    case "hang":
      if (!result.error) failed(`客户端没有被自己的超时打断（status=${result.status}）`);
      return;
    case "reset":
      if (!result.error) failed(`连接没被重置（status=${result.status}）`);
      return;
    case "truncate":
      if (!result.error) failed(`响应没被截断（status=${result.status}）`);
      return;
    case "status":
      if (result.status !== (plan.status ?? 500)) failed(`状态码是 ${result.status}，不是 ${plan.status}`);
      return;
    case "latency":
      if (!result.ok) failed(`加了延迟之后请求反而失败：${result.error ?? result.status}`);
      if (result.ms < (plan.delayMs ?? 0) * 0.8) failed(`延迟没生效（${result.ms}ms 小于 ${plan.delayMs}ms）`);
      return;
  }
}

function transportFault(
  name: string,
  plan: { mode: "latency" | "hang" | "reset" | "truncate" | "status"; delayMs?: number; bytes?: number; status?: number },
): ReifyFaultDefinition {
  return {
    name,
    description: `真 provider 端点上注入 ${plan.mode} 传输故障（走真 fault proxy，带真凭证 header）`,
    arbitrary: fc.constant<Params>({}),
    describe: () => name,
    precondition: async (ctx) => {
      if (!providerFaultsEnabled()) {
        return { applicable: false, reason: "provider 网络故障是显式 opt-in（CHAOS_REIFY_PROVIDER_FAULTS=1）" };
      }
      const sandbox = providerSandbox(ctx);
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) return { applicable: false, reason: "凭证副本里没有可打的 provider" };
      const target = await transportTarget(sandbox, resolved.selection);
      if (!target) return { applicable: false, reason: "解析不出真 provider endpoint（没有 prime-agent 模型注册表）" };
      return { applicable: true, evidence: { endpoint: target.baseUrl, provider: resolved.selection.provider } };
    },
    inject: async (ctx) => {
      const sandbox = providerSandbox(ctx);
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) throw new FaultNotApplicable("凭证副本里没有可打的 provider");
      const target = await transportTarget(sandbox, resolved.selection);
      if (!target) throw new FaultNotApplicable("解析不出真 provider endpoint");
      const result = await runTransportFault({
        baseUrl: target.baseUrl,
        plan,
        authHeaders: target.authHeaders,
        timeoutMs: Number(process.env.CHAOS_REIFY_PROVIDER_TIMEOUT_MS ?? 2_500),
      });
      try {
        assertTransportFaultLanded(name, plan, result);
      } catch (error) {
        // A credential fault armed in the same round really can make the real
        // provider reject the probe: with the credential expired / blanked /
        // dropped the endpoint answers 401 (or 403), and the transport fault
        // then "did not land" because the harness itself broke the credential.
        // That one answer is the credential fault talking, not a transport
        // failure, so it is honestly NotApplicable. Every other probe failure
        // stays a real InjectionFailed -- a credential fault armed nearby must
        // never turn a real transport-injection failure into "did not apply".
        const credential = credentialFaultArmed(ctx);
        const rejection = credentialAuthRejection(result, credential);
        if (rejection) {
          throw new FaultNotApplicable(rejection, { credential, status: result.status, mode: plan.mode });
        }
        throw error;
      }
      ctx.session.armFault(name);
      ctx.session.armedFaults.set(name, { result });
      ctx.trace.record({ kind: "note", name, detail: result });
    },
    recover: async (ctx) => {
      ctx.session.disarmFault(name);
      ctx.trace.note(`${name} 结束，fault proxy 已关闭`);
    },
  };
}

export const providerCredentialExpired = credentialFault("providerCredentialExpired", "expire");
export const providerCredentialDropped = credentialFault("providerCredentialDropped", "drop");
export const providerCredentialBlanked = credentialFault("providerCredentialBlanked", "blank");
export const providerTimeout = transportFault("providerTimeout", { mode: "hang" });
export const providerReset = transportFault("providerReset", { mode: "reset" });
export const providerLatency = transportFault("providerLatency", { mode: "latency", delayMs: 1_500 });
export const providerStreamCut = transportFault("providerStreamCut", { mode: "truncate", bytes: 32, delayMs: 50 });
export const providerRateLimited = transportFault("providerRateLimited", { mode: "status", status: 429 });
export const providerServerError = transportFault("providerServerError", { mode: "status", status: 503 });

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
      output: `build/chaos-retry-${++buildCounter}-${conversation}.step`,
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

function errorMessageOf(settled: { code: number | null; signal: string | null; stdout: string }): string {
  try {
    return String((JSON.parse(settled.stdout) as { error?: { message?: string } }).error?.message ?? settled.signal ?? settled.code);
  } catch {
    return String(settled.signal ?? settled.code);
  }
}

// ---------------------------------------------------------------------------
// The generated space, grouped by the boundary each fault really hits.
// ---------------------------------------------------------------------------

/** Prime / runtime / kernel / worker process and resource faults. */
export const processFaultDefinitions: ReifyFaultDefinition[] = [
  killKernelDuringBuild,
  pauseKernelDuringBuild,
  killAuthorityDuringBuild,
  pauseAuthorityDuringBuild,
  killIdleKernel,
  killKernelChild,
  killRuntimeDuringBuild,
  pauseRuntimeDuringBuild,
  restartRuntimeDuringBuild,
  killPrimeRuntime,
  cpuPressure,
];

/** Real files and real state the product reads and writes. */
export const fileStateFaultDefinitions: ReifyFaultDefinition[] = [
  missingRunStateFile,
  unreadableRunStateFile,
  partialStateWrite,
  missingDesktopProjection,
];

/** Provider / OAuth boundary. */
export const providerFaultDefinitions: ReifyFaultDefinition[] = [
  providerCredentialExpired,
  providerCredentialDropped,
  providerCredentialBlanked,
  providerTimeout,
  providerReset,
  providerLatency,
  providerStreamCut,
  providerRateLimited,
  providerServerError,
];

/** Multi-step timing combinations, not single-step faults. */
export const raceFaultDefinitions: ReifyFaultDefinition[] = [
  raceUserActionDuringKernelFault,
  raceTwoConversationsBuild,
  raceRestartDuringTransition,
  raceLegalOrderSwap,
  raceRepeatSubmitDuringFault,
  raceCrossConversationFault,
];

export const reifyFaultDefinitions: ReifyFaultDefinition[] = [
  ...processFaultDefinitions,
  ...fileStateFaultDefinitions,
  ...providerFaultDefinitions,
  ...raceFaultDefinitions,
];

/** Which boundary each fault really hits, for the CLI and the docs. */
export const FAULT_BOUNDARIES: Record<string, "process" | "file-state" | "provider-oauth" | "race"> = Object.fromEntries([
  ...processFaultDefinitions.map((fault) => [fault.name, "process"] as const),
  ...fileStateFaultDefinitions.map((fault) => [fault.name, "file-state"] as const),
  ...providerFaultDefinitions.map((fault) => [fault.name, "provider-oauth"] as const),
  ...raceFaultDefinitions.map((fault) => [fault.name, "race"] as const),
]);
