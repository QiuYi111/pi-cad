import fc from "fast-check";
import { Session } from "../sut/session.ts";
import { resetHttpLog } from "../sut/http.ts";
import { actionDefinitions } from "../actions/index.ts";
import { checkInvariants } from "../invariants/index.ts";
import { buildSequenceArbitrary } from "../model/commands.ts";
import { InvariantViolation, Trace } from "../types.ts";
import { loadArtifact, type FailureArtifact } from "./artifacts.ts";
import { availableFaults, finalSettleFor, runSequence } from "./runner.ts";

export interface ReplayResult {
  ok: boolean;
  mode: "sequence" | "seed";
  expectedInvariant: string;
  observedInvariant?: string;
  detail?: string;
  steps: number;
}

/** Re-run a recorded sequence (or the recorded fast-check seed) and confirm failure. */
export async function replayArtifact(file: string, options: { seed?: boolean } = {}): Promise<ReplayResult> {
  const artifact: FailureArtifact = loadArtifact(file);
  const session = await Session.start({ bug: artifact.sut.bug });
  try {
    if (options.seed) {
      return await replayBySeed(session, artifact);
    }
    return await replayBySequence(session, artifact);
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function replayBySequence(session: Session, artifact: FailureArtifact): Promise<ReplayResult> {
  const scratch = new Trace();
  await session.faults.recoverAll(scratch).catch(() => undefined);
  await session.reset();
  resetHttpLog();
  const trace = new Trace();
  const sequence = artifact.replaySequence ?? artifact.shrunkSequence;
  let observed: InvariantViolation | null = null;
  let otherError: unknown = null;
  try {
    await runSequence(session, sequence, trace, finalSettleFor(artifact.sut.bug));
  } catch (error) {
    if (error instanceof InvariantViolation) observed = error;
    else otherError = error;
  }
  return {
    ok: observed?.invariant === artifact.invariant,
    mode: "sequence",
    expectedInvariant: artifact.invariant,
    observedInvariant: observed?.invariant,
    detail: observed?.detail ?? (otherError ? String(otherError) : "序列跑完但没有复现失败"),
    steps: sequence.length,
  };
}

async function replayBySeed(session: Session, artifact: FailureArtifact): Promise<ReplayResult> {
  const faults = availableFaults(session.hasExternalFaults);
  const arbitrary = buildSequenceArbitrary(actionDefinitions, faults, Math.max(artifact.originalSequence.length, 4));
  let observed: InvariantViolation | null = null;
  const property = fc.asyncProperty(arbitrary, async (commands) => {
    const trace = new Trace();
    await session.faults.recoverAll(trace).catch(() => undefined);
    await session.reset();
    resetHttpLog();
    for (const command of commands) {
      const { executeCommand, settleWindowFor } = await import("./runner.ts");
      await executeCommand(session, command, trace);
      await new Promise((resolve) => setTimeout(resolve, settleWindowFor(command)));
      await checkInvariants({ session, snapshot: await session.snapshot(), now: Date.now() });
    }
    await new Promise((resolve) => setTimeout(resolve, finalSettleFor(artifact.sut.bug)));
    await checkInvariants({ session, snapshot: await session.snapshot(), now: Date.now() });
  });
  const details = await fc.check(property, { numRuns: 30, seed: artifact.seed });
  if (details.errorInstance instanceof InvariantViolation) observed = details.errorInstance;
  return {
    ok: details.failed && observed?.invariant === artifact.invariant,
    mode: "seed",
    expectedInvariant: artifact.invariant,
    observedInvariant: observed?.invariant,
    detail: details.failed
      ? `seed ${artifact.seed} 复现了 ${observed?.invariant ?? "失败"}`
      : `seed ${artifact.seed} 没有复现失败`,
    steps: ((details.counterexample?.[0] as unknown[] | undefined) ?? []).length,
  };
}
