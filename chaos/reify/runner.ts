import fc from "fast-check";

import { InvariantViolation } from "../types.ts";
import { reifyActionDefinitions } from "./actions.ts";
import { loadReifyArtifact, saveReifyArtifact, type ReifyFailureArtifact } from "./artifacts.ts";
import { reifyFaultDefinitions } from "./faults.ts";
import { checkReifyInvariants, reifyInvariantDefinitions } from "./invariants.ts";
import { buildReifySequenceArbitrary, describeCommand, type Command } from "./model.ts";
import { ReifySession } from "./session.ts";
import { ReifyTrace } from "./trace.ts";
import type { ReifyActionDefinition, ReifyFaultDefinition } from "./types.ts";

export const REIFY_ACTIONS = new Map(reifyActionDefinitions.map((definition) => [definition.name, definition]));
export const REIFY_FAULTS = new Map(reifyFaultDefinitions.map((definition) => [definition.name, definition]));

/** How long to keep reading real state after each command. */
const SETTLE_MS: Record<string, number> = {
  startRun: 300,
  openConversation: 300,
  commitPlan: 250,
  advance: 250,
  build: 500,
  refresh: 250,
  killKernelDuringBuild: 900,
  pauseKernelDuringBuild: 900,
  killAuthorityDuringBuild: 900,
};
const DEFAULT_SETTLE_MS = 200;
const FINAL_SETTLE_MS = Number(process.env.CHAOS_REIFY_FINAL_SETTLE_MS ?? 1_200);
const POLL_INTERVAL_MS = 75;

export const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

export function reifySettleWindowFor(command: Command): number {
  return SETTLE_MS[command.name] ?? DEFAULT_SETTLE_MS;
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
  try {
    await definition.inject({ session, trace, params: command.params });
  } catch (error) {
    // A fault the product did not expose (no active run, no kernel) must never
    // masquerade as a system failure.
    trace.note(`fault ${command.name} 注入失败`, (error as Error).message);
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

/** Inject faults, then prove recovery with a real build before the next step. */
async function recoverInjectedFaults(session: ReifySession, injected: ReifyFaultDefinition[], trace: ReifyTrace): Promise<void> {
  for (const definition of [...injected].reverse()) {
    try {
      await definition.recover({ session, trace, params: {} });
    } catch (error) {
      if (error instanceof InvariantViolation) throw error;
      trace.note(`fault ${definition.name} 恢复失败`, (error as Error).message);
    }
  }
}

export async function runReifySequence(session: ReifySession, commands: Command[], trace: ReifyTrace): Promise<ReifyFaultDefinition[]> {
  const injected: ReifyFaultDefinition[] = [];
  for (const command of commands) {
    trace.executed.push(command);
    await executeReifyCommand(session, command, trace);
    if (command.kind === "fault" && REIFY_FAULTS.has(command.name) && session.activeFaults.includes(command.name)) {
      injected.push(REIFY_FAULTS.get(command.name)!);
    }
    await observeUntil(session, trace, describeCommand(command), reifySettleWindowFor(command));
  }
  await observeUntil(session, trace, "final-settle", FINAL_SETTLE_MS);
  await recoverInjectedFaults(session, injected, trace);
  return injected;
}

export interface ReifyRunOptions {
  numRuns?: number;
  seed?: number;
  maxCommands?: number;
  quiet?: boolean;
  session?: ReifySession;
  save?: boolean;
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
  invariants: string[];
  recoveries: { at: number; after: string; buildMs: number }[];
}

interface RecordedFailure {
  commands: Command[];
  error: unknown;
}

/**
 * Drive the real Reify system with generated action/fault sequences, checking
 * real invariants after every step. On failure the sequence is shrunk by
 * fast-check, replayed against a fresh real project and saved as evidence.
 */
export async function reifyChaosRun(options: ReifyRunOptions = {}): Promise<ReifyRunResult> {
  const session = options.session ?? (await ReifySession.start());
  try {
    const arbitrary = buildReifySequenceArbitrary(reifyActionDefinitions, reifyFaultDefinitions, options.maxCommands ?? 9);
    let firstFailure: RecordedFailure | null = null;

    const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
      const trace = new ReifyTrace();
      await session.reset();
      try {
        await runReifySequence(session, commands, trace);
      } catch (error) {
        if (!firstFailure) firstFailure = { commands: [...commands], error };
        throw error;
      }
    });

    const details = await fc.check(property, { numRuns: options.numRuns ?? 3, seed: options.seed });
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
        invariants: reifyInvariantDefinitions.map((definition) => definition.name),
        recoveries: session.history.recoveries,
      };
    }

    const shrunk = ((details.counterexample?.[0] as Command[] | undefined) ?? []).slice();
    const original = firstFailure?.commands ?? shrunk;
    const artifact = await captureFailure(session, {
      seed: details.seed,
      replayPath: details.counterexamplePath ?? "",
      sequence: shrunk,
      fallback: original,
      expected: details.errorInstance instanceof InvariantViolation ? details.errorInstance : null,
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
      invariants: reifyInvariantDefinitions.map((definition) => definition.name),
      recoveries: session.history.recoveries,
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
    sequence: Command[];
    fallback: Command[];
    expected: InvariantViolation | null;
  },
): Promise<ReifyFailureArtifact> {
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

  return {
    schema: 1,
    sut: "reify",
    createdAt: new Date().toISOString(),
    invariant: effective?.invariant ?? "unknown",
    detail: violation?.detail ?? expected?.detail ?? String(error),
    evidence: effective?.evidence,
    seed: input.seed,
    replayPath: input.replayPath,
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
    project: { root: session.root, project: session.project, canonical: session.canonical, workflowHome: session.workflowHome },
  };
}

export interface ReifyReplayResult {
  ok: boolean;
  mode: "sequence" | "seed";
  expectedInvariant: string;
  observedInvariant?: string;
  detail?: string;
  steps: number;
}

/** Re-run a recorded sequence (or the recorded fast-check seed) and confirm it. */
export async function replayReifyArtifact(file: string, options: { seed?: boolean } = {}): Promise<ReifyReplayResult> {
  const artifact = loadReifyArtifact(file);
  const session = await ReifySession.start();
  try {
    if (options.seed) return await replayBySeed(session, artifact);
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

async function replayBySeed(session: ReifySession, artifact: ReifyFailureArtifact): Promise<ReifyReplayResult> {
  const arbitrary = buildReifySequenceArbitrary(reifyActionDefinitions, reifyFaultDefinitions, Math.max(artifact.originalSequence.length, 4));
  let observed: InvariantViolation | null = null;
  const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    const trace = new ReifyTrace();
    await session.reset();
    await runReifySequence(session, commands, trace);
  });
  const details = await fc.check(property, { numRuns: 12, seed: artifact.seed });
  if (details.errorInstance instanceof InvariantViolation) observed = details.errorInstance;
  return {
    ok: details.failed && observed?.invariant === artifact.invariant,
    mode: "seed",
    expectedInvariant: artifact.invariant,
    observedInvariant: observed?.invariant,
    detail: details.failed ? `seed ${artifact.seed} 复现了 ${observed?.invariant ?? "失败"}` : `seed ${artifact.seed} 没有复现失败`,
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

/** Re-derive the minimal real reproduction from the recorded seed. */
export async function shrinkReifyArtifact(file: string): Promise<ReifyShrinkResult> {
  const artifact = loadReifyArtifact(file);
  const result = await reifyChaosRun({
    seed: artifact.seed,
    numRuns: 30,
    maxCommands: Math.max(artifact.originalSequence.length, 4),
    quiet: true,
    save: false,
  });
  return {
    ok: result.failed && result.invariant === artifact.invariant,
    expectedInvariant: artifact.invariant,
    invariant: result.invariant,
    originalLength: result.originalLength,
    shrunkLength: result.shrunkLength,
    numShrinks: result.numShrinks,
    artifactPath: result.artifactPath,
  };
}

export type { ReifyActionDefinition, ReifyFaultDefinition };
