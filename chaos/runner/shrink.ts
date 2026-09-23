import { Session } from "../sut/session.ts";
import { loadArtifact } from "./artifacts.ts";
import { chaosRun } from "./runner.ts";

export interface ShrinkResult {
  ok: boolean;
  expectedInvariant: string;
  invariant?: string;
  originalLength: number;
  shrunkLength: number;
  numShrinks: number;
}

/**
 * Re-derive the minimal counterexample from the recorded seed. fast-check does
 * the shrinking; this reports how much shorter the reproduction became.
 */
export async function shrinkArtifact(file: string): Promise<ShrinkResult> {
  const artifact = loadArtifact(file);
  const session = await Session.start({ bug: artifact.sut.bug });
  try {
    const result = await chaosRun({
      bug: artifact.sut.bug,
      seed: artifact.seed,
      numRuns: 30,
      session,
      quiet: true,
      save: false,
      maxCommands: Math.max(artifact.originalSequence.length, 4),
    });
    return {
      ok: result.failed && result.invariant === artifact.invariant,
      expectedInvariant: artifact.invariant,
      invariant: result.invariant,
      originalLength: result.originalLength,
      shrunkLength: result.shrunkLength,
      numShrinks: result.numShrinks,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
