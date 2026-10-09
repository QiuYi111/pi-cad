import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InvariantViolation } from "../../types.ts";
import { FaultNotApplicable } from "../types.ts";
import type { FaultPrecondition, ReifyContext } from "../types.ts";
import { sleep } from "../../support/process.ts";

const execFileAsync = promisify(execFile);

/** Is a real external tool on PATH? Used to decide NotApplicable honestly. */
export async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${command}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** The slow model keeps the warm kernel busy long enough to be faulted. */
export const SLOW_SOURCE = "slow_part.py";
export const FAST_SOURCE = "part.py";
/** Real builds and real kernel restarts must finish inside this budget. */
export const RECOVERY_BUDGET_MS = Number(process.env.CHAOS_REIFY_RECOVERY_BUDGET_MS ?? 90_000);
/** Each recovery build needs its own output path, otherwise cadctl serves a cache hit. */
let recoveryCounter = 0;
/** Build output paths must differ per conversation and per attempt. */
let buildCounter = 0;

/** Fresh build-output number: every build path differs per conversation and attempt. */
export function nextBuildId(): number {
  return ++buildCounter;
}


/**
 * The conversation a generated fault param really selects.
 *
 * Every fault that carries `conversationIndex` must use this one value from
 * precondition through injection to recovery. Otherwise the artifact names one
 * object and the fault hits another, and the multi-conversation evidence the
 * artifact carries is not trustworthy.
 */
export function faultConversationIndex(ctx: ReifyContext): number {
  return Number(ctx.params.conversationIndex ?? 0);
}

export function conversationOf(ctx: ReifyContext, index = faultConversationIndex(ctx)): string {
  return ctx.session.conversation(index);
}

/** The run of one conversation as the real API reports it right now. */
export async function runView(ctx: ReifyContext, conversation: string): Promise<{ runId: string | null; status: string | null; phase: string | null }> {
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
export async function runViewOrThrow(
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
export async function capabilityAllowed(ctx: ReifyContext, conversation: string, capability: string): Promise<boolean> {
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

export function buildAllowed(ctx: ReifyContext, conversation: string): Promise<boolean> {
  return capabilityAllowed(ctx, conversation, "cad_build_step");
}

export function commitAllowed(ctx: ReifyContext, conversation: string): Promise<boolean> {
  return capabilityAllowed(ctx, conversation, "cad_commit");
}

/** The events this conversation's run really accepts right now. */
export async function legalTransitions(ctx: ReifyContext, conversation: string): Promise<string[]> {
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
export const TRANSITION_DENIAL =
  /illegal workflow transition|cannot transition run in status|phase obligations remain unmet|transition requires|transition forbids/;

export function transitionDeniedByProduct(message: string): boolean {
  return TRANSITION_DENIAL.test(message);
}

/** Real-state precondition: is there an active run that may build right now? */
export async function activeRunPrecondition(
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
export function buildableRunPrecondition(ctx: ReifyContext, conversationIndex?: number): Promise<FaultPrecondition> {
  return activeRunPrecondition(ctx, conversationIndex ?? faultConversationIndex(ctx), { requireBuild: true });
}

export interface FaultBuild {
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
export async function startFaultBuild(ctx: ReifyContext, fault: string, conversationIndex = faultConversationIndex(ctx)): Promise<FaultBuild> {
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
export async function settleWithin(build: FaultBuild, timeoutMs: number): Promise<{ code: number | null; signal: string | null; stdout: string } | null> {
  return await Promise.race([build.settle(), sleep(timeoutMs).then(() => null)]);
}

/** A recovered system answers another real build with a real STEP artifact. */
export async function proveRecovery(ctx: ReifyContext, after: string, conversationIndex = faultConversationIndex(ctx)): Promise<void> {
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
export function describeKernel(build: FaultBuild): string {
  return `conv=${build.conversation} run=${build.runId ?? "无"} kernel=${build.kernelPid} build=${build.buildChildPid} owner=${build.ownerPid}${
    build.viaRuntime ? "(runtime)" : "(authority)"
  }`;
}

// ---------------------------------------------------------------------------
// 进程 / 资源：kernel、控制面、runtime、Prime
// ---------------------------------------------------------------------------

export function errorMessageOf(settled: { code: number | null; signal: string | null; stdout: string }): string {
  try {
    return String((JSON.parse(settled.stdout) as { error?: { message?: string } }).error?.message ?? settled.signal ?? settled.code);
  } catch {
    return String(settled.signal ?? settled.code);
  }
}
