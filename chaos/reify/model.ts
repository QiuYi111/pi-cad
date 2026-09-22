import fc from "fast-check";
import type { ReifyActionDefinition, ReifyFaultDefinition } from "./types.ts";

export interface Command {
  kind: "action" | "fault";
  name: string;
  params: Record<string, unknown>;
}

/**
 * Generation weights. The point is not uniform coverage: common user paths
 * stay frequent, and the expensive / high-risk races get a directed weight so
 * they are actually explored without drowning the cheap paths.
 */
const WEIGHTS: Record<string, number> = {
  // Common user paths, high frequency.
  startRun: 6,
  openConversation: 4,
  commitPlan: 5,
  advance: 4,
  build: 6,
  refresh: 3,
  // Cheap real reads and repeats.
  switchConversation: 2,
  resumeRun: 2,
  listWorkflows: 1,
  history: 1,
  burstRefresh: 2,
  duplicateCommit: 2,
  retryBuild: 3,
  phaseCard: 1,
  phaseContract: 1,
  completionGate: 1,
  authorize: 1,
  // Real multi-actor combinations.
  concurrentBuild: 3,
  multiConversationBuild: 3,
  desktopRestart: 2,
  // Process / resource faults.
  killKernelDuringBuild: 6,
  pauseKernelDuringBuild: 3,
  killAuthorityDuringBuild: 5,
  pauseAuthorityDuringBuild: 3,
  killIdleKernel: 3,
  killKernelChild: 3,
  killRuntimeDuringBuild: 4,
  pauseRuntimeDuringBuild: 2,
  restartRuntimeDuringBuild: 4,
  killPrimeRuntime: 2,
  cpuPressure: 1,
  // File / state faults.
  missingRunStateFile: 3,
  unreadableRunStateFile: 2,
  partialStateWrite: 2,
  missingDesktopProjection: 2,
  // Provider / OAuth faults.
  providerCredentialExpired: 3,
  providerCredentialDropped: 2,
  providerCredentialBlanked: 2,
  providerTimeout: 2,
  providerReset: 2,
  providerLatency: 1,
  providerStreamCut: 1,
  providerRateLimited: 1,
  providerServerError: 1,
  // Directed weight for timing combinations.
  raceUserActionDuringKernelFault: 4,
  raceTwoConversationsBuild: 3,
  raceRestartDuringTransition: 3,
  raceLegalOrderSwap: 2,
  raceRepeatSubmitDuringFault: 2,
  raceCrossConversationFault: 3,
};

/**
 * Every generated sequence starts from a real run that is really in `cook`,
 * so a generated fault always has a real run (and often a real kernel) to hit.
 * The prefix is part of the sequence, so replay and shrink see exactly what ran.
 */
export const REIFY_SETUP: Command[] = [
  { kind: "action", name: "startRun", params: { conversationIndex: 0 } },
  { kind: "action", name: "commitPlan", params: { conversationIndex: 0 } },
  { kind: "action", name: "advance", params: { event: "plan_ready", conversationIndex: 0 } },
];

/**
 * Really prepare a second working conversation, as explicit commands.
 *
 * The multi-conversation races (two builds at once, one conversation faulted
 * while the other works) need two conversations that really may build. Their
 * preconditions stay strict — two real conversations, active runs, and
 * `model.build` really granted — so a round that wants those faults has to
 * bring the state with it. Preparation is a real action the artifact records,
 * not something a fault does to itself: replay and shrink see the same
 * `openConversation` a user would run, and the minimal sequence still says how
 * the system really got there.
 */
export const REIFY_MULTI_CONVERSATION_SETUP: Command[] = [
  { kind: "action", name: "openConversation", params: {} },
];

/** The named preparations a profile (or a single run) can ask for. */
export const REIFY_PREPARATIONS: Record<string, Command[]> = {
  "multi-conversation": REIFY_MULTI_CONVERSATION_SETUP,
};

export function resolvePreparation(name: string | undefined): Command[] {
  if (!name) return [];
  const commands = REIFY_PREPARATIONS[name];
  if (!commands) throw new Error(`未知的 preparation "${name}"，可选：${Object.keys(REIFY_PREPARATIONS).join(", ")}`);
  return commands.map((command) => ({ ...command, params: { ...command.params } }));
}

/** One fast-check command list: real Reify actions mixed with real faults. */
export function buildReifySequenceArbitrary(
  actions: ReifyActionDefinition[],
  faults: ReifyFaultDefinition[],
  maxLength = 10,
  preparation: Command[] = [],
): fc.Arbitrary<Command[]> {
  const choices = [
    ...actions.map((definition) => ({
      arbitrary: definition.arbitrary.map((params): Command => ({ kind: "action", name: definition.name, params })),
      weight: WEIGHTS[definition.name] ?? 1,
    })),
    ...faults.map((definition) => ({
      arbitrary: definition.arbitrary.map((params): Command => ({ kind: "fault", name: definition.name, params })),
      weight: WEIGHTS[definition.name] ?? 1,
    })),
  ];
  return fc
    .array(fc.oneof(...choices), { minLength: 2, maxLength })
    .map((rest) => [...REIFY_SETUP, ...preparation, ...rest]);
}

export function describeCommand(command: Command): string {
  const params = Object.entries(command.params)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
  return `${command.kind}:${command.name}${params ? `(${params})` : ""}`;
}
