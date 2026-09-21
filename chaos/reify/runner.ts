import fc from "fast-check";
import { join } from "node:path";

import { InvariantViolation } from "../types.ts";
import { reifyActionDefinitions } from "./actions.ts";
import { loadReifyArtifact, saveReifyArtifact, type ReifyFailureArtifact } from "./artifacts.ts";
import { inspectReifyComponents, type ReifyComponents } from "./components.ts";
import { reifyFaultDefinitions } from "./faults.ts";
import { checkInvariantsOn, checkReifyInvariants, reifyInvariantDefinitions } from "./invariants.ts";
import { buildReifySequenceArbitrary, describeCommand, type Command } from "./model.ts";
import { ReifySession } from "./session.ts";
import { ReifyTrace } from "./trace.ts";
import { ReifyRuntime } from "./runtime.ts";
import { FaultNotApplicable, type FaultOutcome, type FaultPrecondition, type ReifyActionDefinition, type ReifyFaultDefinition } from "./types.ts";

export const REIFY_ACTIONS = new Map(reifyActionDefinitions.map((definition) => [definition.name, definition]));
export const REIFY_FAULTS = new Map(reifyFaultDefinitions.map((definition) => [definition.name, definition]));

/**
 * The fault pool a run may generate from.
 *
 * A campaign profile narrows this so a targeted run really explores one
 * boundary instead of hoping the weighted mixed space picks it. The pool is
 * part of the generator shape: a fast-check path only resolves against the
 * same pool, so it is stored in the artifact next to seed and path.
 */
export function selectReifyFaults(scope?: string[]): ReifyFaultDefinition[] {
  if (!scope?.length) return reifyFaultDefinitions;
  const allowed = new Set(scope);
  const selected = reifyFaultDefinitions.filter((definition) => allowed.has(definition.name));
  if (!selected.length) throw new Error(`fault scope 里没有任何已知 fault：${scope.join(", ")}`);
  return selected;
}

/** How long to keep reading real state after each command. */
const SETTLE_MS: Record<string, number> = {
  startRun: 300,
  openConversation: 300,
  commitPlan: 250,
  advance: 250,
  build: 500,
  refresh: 250,
  history: 250,
  listWorkflows: 200,
  retryBuild: 500,
  concurrentBuild: 700,
  multiConversationBuild: 900,
  duplicateCommit: 350,
  burstRefresh: 300,
  switchConversation: 300,
  resumeRun: 300,
  stopRun: 300,
  phaseCard: 250,
  phaseContract: 250,
  completionGate: 250,
  authorize: 200,
  killKernelDuringBuild: 900,
  pauseKernelDuringBuild: 900,
  killAuthorityDuringBuild: 900,
};
const DEFAULT_SETTLE_MS = 200;
/** fast-check sequence length used when a run does not ask for one. */
const DEFAULT_MAX_COMMANDS = 9;
const FINAL_SETTLE_MS = Number(process.env.CHAOS_REIFY_FINAL_SETTLE_MS ?? 1_200);
const POLL_INTERVAL_MS = 75;

export const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

/**
 * A real session in the same mode the run used. Runtime mode matters for
 * replay: a fault that kills the long-lived runtime only applies when the
 * requests really go through that runtime.
 */
export async function startReifySession(runtimeMode = false): Promise<ReifySession> {
  const session = await ReifySession.start();
  if (!runtimeMode) return session;
  const runtime = await ReifyRuntime.start({
    project: session.project,
    runtimeDirectory: join(session.root, "runtime"),
    env: session.env,
  });
  session.attachRuntime(runtime);
  return session;
}

export function reifySettleWindowFor(command: Command): number {
  return SETTLE_MS[command.name] ?? DEFAULT_SETTLE_MS;
}

/**
 * Inject one fault and record exactly what happened.
 *
 * Applicability is decided from real state *before* injection (or by a fault
 * deliberately raising `FaultNotApplicable`). Every other exception is a real
 * failure and is recorded as `InjectionFailed`; it is never folded into
 * "this fault did not apply".
 */
export async function injectReifyFault(
  session: ReifySession,
  definition: ReifyFaultDefinition,
  command: Command,
  trace: ReifyTrace,
): Promise<FaultOutcome> {
  const ctx = { session, trace, params: command.params };
  let precondition: FaultPrecondition = { applicable: true };
  if (definition.precondition) {
    try {
      precondition = await definition.precondition(ctx);
    } catch (error) {
      const outcome: FaultOutcome = {
        name: definition.name,
        phase: "inject",
        status: "InjectionFailed",
        at: Date.now(),
        reason: `前置检查读真状态失败：${(error as Error).message}`,
      };
      session.recordFaultOutcome(outcome);
      return outcome;
    }
  }
  if (!precondition.applicable) {
    const outcome: FaultOutcome = {
      name: definition.name,
      phase: "inject",
      status: "NotApplicable",
      at: Date.now(),
      reason: precondition.reason ?? "不适用",
      ...(precondition.evidence === undefined ? {} : { evidence: precondition.evidence }),
    };
    session.recordFaultOutcome(outcome);
    trace.note(`fault ${definition.name} 不适用：${outcome.reason}`);
    return outcome;
  }
  try {
    await definition.inject(ctx);
    session.armFault(definition.name);
    const outcome: FaultOutcome = { name: definition.name, phase: "inject", status: "Injected", at: Date.now() };
    session.recordFaultOutcome(outcome);
    return outcome;
  } catch (error) {
    if (error instanceof FaultNotApplicable) {
      const outcome: FaultOutcome = {
        name: definition.name,
        phase: "inject",
        status: "NotApplicable",
        at: Date.now(),
        reason: error.reason,
        ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
      };
      session.recordFaultOutcome(outcome);
      trace.note(`fault ${definition.name} 不适用：${error.reason}`);
      return outcome;
    }
    // A real invariant the product broke while we were injecting is a finding,
    // not a harness problem: let it through unchanged.
    if (error instanceof InvariantViolation) throw error;
    const outcome: FaultOutcome = {
      name: definition.name,
      phase: "inject",
      status: "InjectionFailed",
      at: Date.now(),
      reason: (error as Error).message,
    };
    session.recordFaultOutcome(outcome);
    return outcome;
  }
}

/** Run one real command. Rejected requests are notes; invariants judge state. */
export async function executeReifyCommand(session: ReifySession, command: Command, trace: ReifyTrace): Promise<void> {
  if (command.kind === "action") {
    const definition = REIFY_ACTIONS.get(command.name);
    if (!definition) {
      trace.note(`未知 action ${command.name}`);
      return;
    }
    await definition.run({ session, trace, params: command.params });
    return;
  }
  const definition = REIFY_FAULTS.get(command.name);
  if (!definition) {
    trace.note(`未知 fault ${command.name}`);
    return;
  }
  const outcome = await injectReifyFault(session, definition, command, trace);
  if (outcome.status === "InjectionFailed") {
    // InjectionFailed is never silent: the fault said the precondition held and
    // then the real system threw. That is either a harness bug or a product
    // bug, and either way it must be visible in the failure artifact.
    throw new InvariantViolation(
      "fault-outcome-honest",
      `fault ${definition.name} 注入失败：${outcome.reason}`,
      { fault: definition.name, reason: outcome.reason },
    );
  }
}

async function observeUntil(session: ReifySession, trace: ReifyTrace, label: string, windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  let recorded = false;
  for (;;) {
    const snapshot = await session.snapshot();
    if (!recorded) {
      trace.observe(snapshot, label);
      recorded = true;
    }
    await checkReifyInvariants({ session, snapshot, now: Date.now() });
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** A fault that really got injected, together with the params it ran with. */
export interface InjectedFault {
  definition: ReifyFaultDefinition;
  params: Record<string, unknown>;
}

/** Inject faults, then prove recovery with a real build before the next step. */
export async function recoverInjectedFaults(
  session: ReifySession,
  injected: Array<ReifyFaultDefinition | InjectedFault>,
  trace: ReifyTrace,
): Promise<void> {
  const normalized: InjectedFault[] = injected.map((entry) =>
    "definition" in entry ? entry : { definition: entry, params: {} },
  );
  for (const { definition, params } of [...normalized].reverse()) {
    try {
      // Recovery must see the same params the injection used: a race that hit
      // conversation B has to prove recovery for conversation B.
      await definition.recover({ session, trace, params });
      session.recordFaultOutcome({ name: definition.name, phase: "recover", status: "Recovered", at: Date.now() });
    } catch (error) {
      session.recordFaultOutcome({
        name: definition.name,
        phase: "recover",
        status: "RecoveryFailed",
        at: Date.now(),
        ...(error instanceof InvariantViolation ? {} : { reason: (error as Error).message }),
      });
      if (error instanceof InvariantViolation) throw error;
      // A failed recovery is a real system failure, not a note: the fault may
      // still be armed and nothing proved the system healed. Never swallow it.
      throw new InvariantViolation(
        "recovery-convergence",
        `fault ${definition.name} 恢复失败：${(error as Error).message}`,
        { fault: definition.name },
      );
    }
  }
}

export async function runReifySequence(session: ReifySession, commands: Command[], trace: ReifyTrace): Promise<ReifyFaultDefinition[]> {
  const injected: InjectedFault[] = [];
  for (const command of commands) {
    trace.executed.push(command);
    await executeReifyCommand(session, command, trace);
    if (command.kind === "fault" && REIFY_FAULTS.has(command.name) && session.activeFaults.includes(command.name)) {
      injected.push({ definition: REIFY_FAULTS.get(command.name)!, params: command.params });
    }
    await observeUntil(session, trace, describeCommand(command), reifySettleWindowFor(command));
  }
  await observeUntil(session, trace, "final-settle", FINAL_SETTLE_MS);
  await recoverInjectedFaults(session, injected, trace);
  if (session.activeFaults.length) {
    // Every injected fault must have been really recovered; a fault left armed
    // means the next iteration starts from damaged state.
    throw new InvariantViolation("recovery-convergence", `故障没回收：${session.activeFaults.join(", ")}`, {
      activeFaults: [...session.activeFaults],
    });
  }
  // Recovery only counts if the real state after it still satisfies every
  // invariant: take a fresh snapshot and check again instead of trusting that
  // a build succeeded.
  await checkInvariantsOn(session, trace, "post-recovery");
  return injected.map((entry) => entry.definition);
}

export interface ReifyRunOptions {
  numRuns?: number;
  seed?: number;
  /** fast-check counterexample path; replays that exact path instead of re-searching. */
  replayPath?: string;
  maxCommands?: number;
  /** Drive every request through the long-lived runtime instead of one process per call. */
  runtime?: boolean;
  quiet?: boolean;
  session?: ReifySession;
  save?: boolean;
  /**
   * Restrict generation to these faults (a campaign profile). The pool is part
   * of the generator shape and is recorded in the artifact so replay/shrink
   * rebuild the exact same arbitrary.
   */
  faultScope?: string[];
  /**
   * `false` stops at the first failure without shrinking. A campaign round
   * wants the raw counterexample fast; the shrink belongs to triage, on the
   * unique failures only.
   */
  shrink?: boolean;
  /**
   * `false` saves the raw failure without the extra replay and component
   * probe. The artifact says so instead of pretending it was verified.
   */
  verify?: boolean;
}

export interface ReifyRunResult {
  failed: boolean;
  seed: number;
  numRuns: number;
  invariant?: string;
  detail?: string;
  originalLength: number;
  shrunkLength: number;
  numShrinks: number;
  replayPath?: string;
  artifactPath?: string;
  replayOk?: boolean;
  /** The fault pool this run generated from; absent means the full space. */
  faultScope?: string[];
  /**
   * The first generated round: what the generator produced, what the real
   * system actually executed, and the fault outcomes of that round alone.
   * Shrink attempts run the property again, so this is deliberately the first
   * one instead of "whatever ran last".
   */
  firstRound?: { generated: Command[]; executed: Command[]; faultOutcomes: FaultOutcome[] };
  invariants: string[];
  recoveries: { at: number; after: string; buildMs: number }[];
  /** Explicit fault results: NotApplicable / Injected / InjectionFailed / Recovered / RecoveryFailed. */
  faultOutcomes: FaultOutcome[];
}

interface RecordedFailure {
  commands: Command[];
  error: unknown;
  /** The real trace of the failing round, so a raw artifact still carries evidence. */
  trace: ReifyTrace;
}

/**
 * Drive the real Reify system with generated action/fault sequences, checking
 * real invariants after every step. On failure the sequence is shrunk by
 * fast-check, replayed against a fresh real project and saved as evidence.
 */
export async function reifyChaosRun(options: ReifyRunOptions = {}): Promise<ReifyRunResult> {
  const session = options.session ?? (await startReifySession(options.runtime ?? false));
  const maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
  const runtimeMode = options.runtime ?? session.attachedRuntime !== null;
  const faultScope = options.faultScope?.length ? [...options.faultScope] : undefined;
  const shrink = options.shrink !== false;
  const verify = shrink && options.verify !== false;
  // Outcomes are cleared by `reset()` at the start of every iteration, so the
  // whole run's results have to be collected as the iterations go.
  const allFaultOutcomes: FaultOutcome[] = [];
  try {
    const arbitrary = buildReifySequenceArbitrary(reifyActionDefinitions, selectReifyFaults(faultScope), maxCommands);
    let firstFailure: RecordedFailure | null = null;
    let firstRound: { generated: Command[]; executed: Command[]; faultOutcomes: FaultOutcome[] } | null = null;

    const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
      const trace = new ReifyTrace();
      await session.reset();
      try {
        await runReifySequence(session, commands, trace);
      } catch (error) {
        if (!firstFailure) firstFailure = { commands: [...commands], error, trace };
        throw error;
      } finally {
        allFaultOutcomes.push(...session.faultOutcomes);
        firstRound ??= {
          generated: [...commands],
          executed: [...trace.executed],
          faultOutcomes: [...session.faultOutcomes],
        };
      }
    });

    // `path` makes fast-check replay the recorded counterexample exactly (and
    // then continue shrinking from it), instead of searching the seed again.
    const details = await fc.check(property, {
      numRuns: options.numRuns ?? 3,
      seed: options.seed,
      path: options.replayPath ?? "",
      // A campaign round is a cheap sample: stop at the first failure and keep
      // the raw sequence. Shrinking many candidates is the expensive part and
      // only the unique failures are worth it.
      ...(shrink ? {} : { endOnFailure: true }),
    });
    if (!details.failed) {
      if (!options.quiet) {
        process.stdout.write(
          `reify chaos: ${details.numRuns} 轮全部通过（seed=${details.seed}，invariants=${reifyInvariantDefinitions.length}）\n`,
        );
      }
      return {
        failed: false,
        seed: details.seed,
        numRuns: details.numRuns,
        originalLength: 0,
        shrunkLength: 0,
        numShrinks: 0,
        ...(faultScope ? { faultScope } : {}),
        ...(firstRound ? { firstRound } : {}),
        invariants: reifyInvariantDefinitions.map((definition) => definition.name),
        recoveries: session.history.recoveries,
        faultOutcomes: [...allFaultOutcomes],
      };
    }

    const shrunk = ((details.counterexample?.[0] as Command[] | undefined) ?? []).slice();
    const original = firstFailure?.commands ?? shrunk;
    const artifact = await captureFailure(session, {
      seed: details.seed,
      replayPath: details.counterexamplePath ?? "",
      maxCommands,
      runtimeMode,
      faultScope,
      sequence: shrunk,
      fallback: original,
      expected: details.errorInstance instanceof InvariantViolation ? details.errorInstance : null,
      trace: firstFailure?.trace,
      verify,
      inspect: verify && options.save !== false,
    });
    const artifactPath = options.save === false ? undefined : saveReifyArtifact(artifact);

    if (!options.quiet) {
      process.stdout.write(
        `reify chaos: 发现真问题 ${artifact.invariant}\n` +
          `  ${artifact.detail}\n` +
          `  seed=${details.seed} path=${details.counterexamplePath}\n` +
          `  原始序列 ${original.length} 步 → shrink 到 ${shrunk.length} 步（numShrinks=${details.numShrinks}）\n` +
          `  artifact=${artifactPath ?? "(未保存)"}\n`,
      );
    }

    return {
      failed: true,
      seed: details.seed,
      numRuns: details.numRuns,
      invariant: artifact.invariant,
      detail: artifact.detail,
      originalLength: artifact.originalSequence.length,
      shrunkLength: artifact.shrunkSequence.length,
      numShrinks: details.numShrinks,
      replayPath: artifact.replayPath,
      artifactPath,
      replayOk: artifact.reproducible,
      ...(faultScope ? { faultScope } : {}),
      ...(firstRound ? { firstRound } : {}),
      invariants: reifyInvariantDefinitions.map((definition) => definition.name),
      recoveries: session.history.recoveries,
      faultOutcomes: [...allFaultOutcomes],
    };
  } finally {
    if (!options.session) await session.close().catch(() => undefined);
  }
}

/** Replay the recorded (or shrunk) sequence against a fresh real project. */
async function captureFailure(
  session: ReifySession,
  input: {
    seed: number;
    replayPath: string;
    maxCommands: number;
    runtimeMode: boolean;
    faultScope?: string[];
    sequence: Command[];
    fallback: Command[];
    expected: InvariantViolation | null;
    /** The trace of the round that first failed, for the unverified fast path. */
    trace?: ReifyTrace;
    /** When false, the artifact is saved raw and marked as not yet verified. */
    verify: boolean;
    /** Attach real component observations; disabled for cheap in-process shrinks. */
    inspect: boolean;
  },
): Promise<ReifyFailureArtifact> {
  if (!input.verify) return rawFailureArtifact(session, input);
  const attempt = async (sequence: Command[]) => {
    const trace = new ReifyTrace();
    await session.reset();
    try {
      await runReifySequence(session, sequence, trace);
      return { trace, violation: null as InvariantViolation | null, error: null as unknown };
    } catch (error) {
      return {
        trace,
        violation: error instanceof InvariantViolation ? error : null,
        error,
      };
    }
  };

  let { trace, violation, error } = await attempt(input.sequence);
  let replayed = input.sequence;
  if (!violation && input.fallback.length !== input.sequence.length) {
    ({ trace, violation, error } = await attempt(input.fallback));
    replayed = input.fallback;
  }
  const expected = input.expected instanceof InvariantViolation ? input.expected : null;
  const effective = violation ?? expected;
  if (!violation && !effective) throw (error ?? new Error("失败序列没有复现"));
  // The sequence stops at the failing command, so the honest minimal
  // reproduction is the prefix that actually ran.
  const executed = [...trace.executed];
  const usedSequence = violation ? executed : replayed;

  // Join the newly connected real components (runtime/provider/desktop/wsl)
  // into the evidence. A component probe that fails must not hide the primary
  // invariant failure, so it degrades to `undefined` with a note.
  let components: ReifyComponents | undefined;
  if (input.inspect) {
    try {
      // Artifact capture is evidence collection, so it stays read-only: never
      // fire a real provider request while saving a failure artifact.
      components = await inspectReifyComponents(session, { probeProvider: false });
    } catch (error) {
      trace.note(`组件观测失败：${(error as Error).message}`);
    }
  }

  return {
    schema: 1,
    sut: "reify",
    createdAt: new Date().toISOString(),
    invariant: effective?.invariant ?? "unknown",
    detail: violation?.detail ?? expected?.detail ?? String(error),
    evidence: effective?.evidence,
    seed: input.seed,
    replayPath: input.replayPath,
    maxCommands: input.maxCommands,
    runtimeMode: input.runtimeMode,
    ...(input.faultScope?.length ? { faultScope: input.faultScope } : {}),
    originalSequence: input.fallback,
    shrunkSequence: input.sequence,
    replaySequence: usedSequence,
    reproducible: violation !== null,
    actionSequence: usedSequence.filter((command) => command.kind === "action"),
    faultSequence: usedSequence.filter((command) => command.kind === "fault"),
    requests: session.requests,
    ids: {
      conversations: [...trace.ids.conversations],
      runs: [...trace.ids.runs],
      kernels: [...trace.ids.kernels],
    },
    stateTimeline: trace.timeline,
    logs: trace.notes,
    recoveries: session.history.recoveries,
    faultOutcomes: [...session.faultOutcomes],
    project: { root: session.root, project: session.project, canonical: session.canonical, workflowHome: session.workflowHome },
    ...(components ? { components } : {}),
  };
}

export interface ReifyReplayResult {
  ok: boolean;
  mode: "sequence" | "seed+path";
  expectedInvariant: string;
  observedInvariant?: string;
  detail?: string;
  steps: number;
}

/**
 * The fast, honest failure record a campaign round writes.
 *
 * Nothing here is invented: the sequence is the raw counterexample fast-check
 * produced, the timeline comes from the real trace of that round, and the
 * missing pieces (replay result, shrink result, component probe) are simply
 * absent rather than faked. Triage fills them in for the unique failures.
 */
function rawFailureArtifact(
  session: ReifySession,
  input: {
    seed: number;
    replayPath: string;
    maxCommands: number;
    runtimeMode: boolean;
    faultScope?: string[];
    sequence: Command[];
    fallback: Command[];
    expected: InvariantViolation | null;
    trace?: ReifyTrace;
  },
): ReifyFailureArtifact {
  const trace = input.trace;
  const executed = trace ? [...trace.executed] : input.sequence;
  return {
    schema: 1,
    sut: "reify",
    createdAt: new Date().toISOString(),
    invariant: input.expected?.invariant ?? "unknown",
    detail: input.expected?.detail ?? "只有原始失败序列，没拿到 invariant 细节",
    ...(input.expected?.evidence === undefined ? {} : { evidence: input.expected.evidence }),
    seed: input.seed,
    replayPath: input.replayPath,
    maxCommands: input.maxCommands,
    runtimeMode: input.runtimeMode,
    ...(input.faultScope?.length ? { faultScope: input.faultScope } : {}),
    originalSequence: input.fallback,
    shrunkSequence: input.sequence,
    replaySequence: executed,
    // Not verified yet, and it says so: triage replays and shrinks it.
    reproducible: false,
    actionSequence: executed.filter((command) => command.kind === "action"),
    faultSequence: executed.filter((command) => command.kind === "fault"),
    requests: [...session.requests],
    ids: {
      conversations: [...(trace?.ids.conversations ?? [])],
      runs: [...(trace?.ids.runs ?? [])],
      kernels: [...(trace?.ids.kernels ?? [])],
    },
    stateTimeline: trace ? [...trace.timeline] : [],
    logs: [
      ...(trace?.notes ?? []),
      "campaign 快跑模式：这轮只落原始失败序列，replay / shrink 交给 triage 阶段",
    ],
    recoveries: [...session.history.recoveries],
    faultOutcomes: [...session.faultOutcomes],
    project: { root: session.root, project: session.project, canonical: session.canonical, workflowHome: session.workflowHome },
  };
}

/** Re-run a recorded sequence (or the recorded seed+path) and confirm it. */
export async function replayReifyArtifact(file: string, options: { seed?: boolean } = {}): Promise<ReifyReplayResult> {
  const artifact = loadReifyArtifact(file);
  // Replay in the mode the failure was recorded in: a runtime-lifecycle fault
  // only reproduces when requests really go through the long-lived runtime.
  const session = await startReifySession(artifact.runtimeMode ?? false);
  try {
    if (options.seed) return await replayBySeedAndPath(session, artifact);
    const sequence = artifact.replaySequence ?? artifact.shrunkSequence;
    const trace = new ReifyTrace();
    await session.reset();
    let observed: InvariantViolation | null = null;
    let other: unknown = null;
    try {
      await runReifySequence(session, sequence, trace);
    } catch (error) {
      if (error instanceof InvariantViolation) observed = error;
      else other = error;
    }
    return {
      ok: observed?.invariant === artifact.invariant,
      mode: "sequence",
      expectedInvariant: artifact.invariant,
      observedInvariant: observed?.invariant,
      detail: observed?.detail ?? (other ? String(other) : "序列跑完但没有复现失败"),
      steps: sequence.length,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * Replay the exact fast-check counterexample: same seed, same path, same
 * generator shape. Nothing is searched again, so a failure here means the
 * recorded path really is the one the generator produced.
 */
async function replayBySeedAndPath(session: ReifySession, artifact: ReifyFailureArtifact): Promise<ReifyReplayResult> {
  const missing = (detail: string): ReifyReplayResult => ({
    ok: false,
    mode: "seed+path",
    expectedInvariant: artifact.invariant,
    detail,
    steps: 0,
  });
  if (!artifact.replayPath) return missing("artifact 里没有 fast-check path，没法按原路径重放");
  const arbitrary = buildReifySequenceArbitrary(
    reifyActionDefinitions,
    selectReifyFaults(artifact.faultScope),
    artifact.maxCommands,
  );
  let observed: InvariantViolation | null = null;
  let other: unknown = null;
  const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    const trace = new ReifyTrace();
    await session.reset();
    try {
      await runReifySequence(session, commands, trace);
    } catch (error) {
      other = error;
      throw error;
    }
  });
  const details = await fc.check(property, {
    seed: artifact.seed,
    path: artifact.replayPath,
    endOnFailure: true,
    numRuns: 1,
  });
  if (details.errorInstance instanceof InvariantViolation) observed = details.errorInstance;
  const ok = details.failed && observed?.invariant === artifact.invariant;
  return {
    ok,
    mode: "seed+path",
    expectedInvariant: artifact.invariant,
    observedInvariant: observed?.invariant,
    detail: ok
      ? `seed=${artifact.seed} path=${artifact.replayPath} 精确复现了 ${observed?.invariant}`
      : details.failed
        ? `seed=${artifact.seed} path=${artifact.replayPath} 复现了别的失败：${observed?.invariant ?? String(other)}`
        : `seed=${artifact.seed} path=${artifact.replayPath} 没有复现失败`,
    steps: ((details.counterexample?.[0] as unknown[] | undefined) ?? []).length,
  };
}

export interface ReifyShrinkResult {
  ok: boolean;
  expectedInvariant: string;
  invariant?: string;
  originalLength: number;
  shrunkLength: number;
  numShrinks: number;
  artifactPath?: string;
}

/** Replay the recorded seed+path, then shrink from exactly that counterexample. */
export async function shrinkReifyArtifact(file: string): Promise<ReifyShrinkResult> {
  const artifact = loadReifyArtifact(file);
  if (!artifact.replayPath) throw new Error("artifact 里没有 fast-check path，没法按原路径 shrink");
  const result = await reifyChaosRun({
    seed: artifact.seed,
    replayPath: artifact.replayPath,
    maxCommands: artifact.maxCommands,
    runtime: artifact.runtimeMode ?? false,
    faultScope: artifact.faultScope,
    quiet: true,
    save: false,
  });
  return {
    ok: result.failed && result.invariant === artifact.invariant,
    expectedInvariant: artifact.invariant,
    invariant: result.invariant,
    originalLength: artifact.originalSequence.length,
    shrunkLength: result.shrunkLength,
    numShrinks: result.numShrinks,
    artifactPath: result.artifactPath,
  };
}

export type { ReifyActionDefinition, ReifyFaultDefinition };
