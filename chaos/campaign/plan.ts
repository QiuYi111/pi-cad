import { resolvePreparation } from "../reify/model.ts";
import { profileFaultScope, type CampaignProfile } from "./profiles.ts";
import type { PlannedRound } from "./types.ts";

/**
 * A deterministic seed per round.
 *
 * `base + index` would hand fast-check adjacent seeds, and adjacent seeds are
 * not independent samples. This spreads them while staying a pure function of
 * the manifest, so `campaign rerun` reproduces the same rounds.
 */
export function deriveRoundSeed(baseSeed: number, index: number): number {
  let x = (baseSeed + Math.imul(index, 0x9e3779b9)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/**
 * The profile cycle. Repeating each profile by weight in declaration order
 * makes coverage something the campaign guarantees, not something it hopes
 * the weighted generator produces: every profile in the cycle really runs.
 */
export function buildProfileCycle(profiles: CampaignProfile[]): CampaignProfile[] {
  const cycle: CampaignProfile[] = [];
  for (const profile of profiles) {
    const slots = Math.max(1, Math.floor(profile.weight));
    for (let slot = 0; slot < slots; slot += 1) cycle.push(profile);
  }
  return cycle;
}

export interface RoundPlanInput {
  rounds: number;
  seed: number;
  maxCommands: number;
  profiles: CampaignProfile[];
  faultPool: string[];
  /** 0 = never drive the long-lived runtime, 1 = always, in between = split. */
  runtimeRatio: number;
}

export function buildRoundPlan(input: RoundPlanInput): PlannedRound[] {
  const cycle = buildProfileCycle(input.profiles);
  if (!cycle.length) throw new Error("campaign 没有任何 profile");
  const every = input.runtimeRatio >= 1 ? 1 : input.runtimeRatio <= 0 ? 0 : Math.max(1, Math.round(1 / input.runtimeRatio));
  const plan: PlannedRound[] = [];
  for (let index = 0; index < input.rounds; index += 1) {
    const profile = cycle[index % cycle.length]!;
    plan.push({
      index,
      seed: deriveRoundSeed(input.seed, index),
      profile: profile.name,
      // Runtime mode changes which faults apply, not the generator shape, so
      // it is safe to vary per round. Artifacts record the mode they ran in.
      runtimeMode: every === 0 ? false : every === 1 ? true : index % every === 0,
      maxCommands: input.maxCommands,
      faultScope: profileFaultScope(profile, input.faultPool),
      // Preparation is part of the sequence, so a round that wants the
      // multi-conversation races really starts from two working conversations.
      preparation: resolvePreparation(profile.preparation),
    });
  }
  return plan;
}
