import { FAULT_BOUNDARIES } from "../reify/faults.ts";
import type { CampaignCoverage, CampaignRound, FaultBoundary } from "./types.ts";

const AUTHORITY_ACTIONS = [
  "startRun",
  "openConversation",
  "switchConversation",
  "commitPlan",
  "advance",
  "stopRun",
  "duplicateCommit",
  "phaseCard",
  "phaseContract",
  "completionGate",
  "authorize",
  "desktopRestart",
];

const RUN_STORE_ACTIONS = [
  "history",
  "refresh",
  "burstRefresh",
  "resumeRun",
  "listWorkflows",
  "missingRunStateFile",
  "unreadableRunStateFile",
  "partialStateWrite",
];

const KERNEL_ACTIONS = ["build", "retryBuild", "concurrentBuild", "multiConversationBuild"];

/**
 * Which real component a command touches. `chaos reify inspect` proves these
 * components are reachable; this maps the campaign's own commands onto them so
 * the report can say what the campaign actually exercised.
 */
export function componentsForCommand(name: string): string[] {
  const components = new Set<string>();
  if (/Kernel/.test(name) || KERNEL_ACTIONS.includes(name)) components.add("kernel");
  if (/Runtime/.test(name)) components.add("runtime");
  if (/Prime/.test(name)) components.add("prime");
  if (/^provider/.test(name)) components.add("provider-oauth");
  if (/Desktop/.test(name)) components.add("desktop-projection");
  if (AUTHORITY_ACTIONS.includes(name)) components.add("authority");
  if (RUN_STORE_ACTIONS.includes(name)) components.add("run-store");
  return [...components];
}

const bump = (counter: Record<string, number>, key: string): void => {
  counter[key] = (counter[key] ?? 0) + 1;
};

export function aggregateCoverage(
  rounds: CampaignRound[],
  invariantsChecked: string[],
  profiles: string[],
): CampaignCoverage {
  const coverage: CampaignCoverage = {
    rounds: rounds.length,
    roundsPassed: 0,
    roundsFailed: 0,
    roundsErrored: 0,
    distinctSeeds: 0,
    stateObservations: 0,
    actions: {},
    faultsInjected: {},
    faultsNotApplicable: {},
    faultsInjectionFailed: {},
    faultsRecoveryFailed: {},
    invariantsChecked: [...invariantsChecked],
    boundaries: Object.fromEntries(
      ["process", "file-state", "provider-oauth", "race"].map((boundary) => [boundary, { rounds: 0, injected: 0 }]),
    ),
    components: {},
    profiles: Object.fromEntries(profiles.map((profile) => [profile, 0])),
    runtimeRounds: 0,
    oneShotRounds: 0,
  };

  const seeds = new Set<number>();
  for (const round of rounds) {
    if (round.status === "passed") coverage.roundsPassed += 1;
    else if (round.status === "failed") coverage.roundsFailed += 1;
    else coverage.roundsErrored += 1;
    seeds.add(round.seed);
    if (round.runtimeMode) coverage.runtimeRounds += 1;
    else coverage.oneShotRounds += 1;
    bump(coverage.profiles, round.profile);

    const roundBoundaries = new Set<FaultBoundary>();
    for (const command of round.commands) {
      const [kind, name] = command.split(":");
      if (!name) continue;
      if (kind === "action") bump(coverage.actions, name);
      for (const component of componentsForCommand(name)) bump(coverage.components, component);
    }
    for (const name of round.injectedFaults) {
      bump(coverage.faultsInjected, name);
      const boundary = FAULT_BOUNDARIES[name];
      if (boundary) {
        roundBoundaries.add(boundary);
        coverage.boundaries[boundary]!.injected += 1;
      }
    }
    for (const name of round.notApplicableFaults) bump(coverage.faultsNotApplicable, name);
    // InjectionFailed / RecoveryFailed are real signals, so they are counted
    // from the explicit outcomes rather than only from the round's summary.
    for (const outcome of round.faultOutcomes) {
      if (outcome.phase === "inject" && outcome.status === "InjectionFailed") bump(coverage.faultsInjectionFailed, outcome.name);
      if (outcome.phase === "recover" && outcome.status === "RecoveryFailed") bump(coverage.faultsRecoveryFailed, outcome.name);
    }
    for (const boundary of roundBoundaries) coverage.boundaries[boundary]!.rounds += 1;
  }

  coverage.distinctSeeds = seeds.size;
  // Every real state observation the campaign took. Each round observes every
  // step plus the final settle window, so this is a lower bound on real states.
  coverage.stateObservations = rounds.reduce((total, round) => total + round.commands.length * 2 + 2, 0);
  return coverage;
}
