import fc from "fast-check";
import type { ReifyActionDefinition, ReifyFaultDefinition } from "./types.ts";

export interface Command {
  kind: "action" | "fault";
  name: string;
  params: Record<string, unknown>;
}

const WEIGHTS: Record<string, number> = {
  startRun: 6,
  openConversation: 4,
  commitPlan: 5,
  advance: 4,
  build: 6,
  refresh: 2,
  killKernelDuringBuild: 6,
  pauseKernelDuringBuild: 3,
  killAuthorityDuringBuild: 5,
};

/**
 * Every generated sequence starts from a real run that is really in `cook`,
 * so a generated fault always has a real kernel to hit. The prefix is part of
 * the sequence, so replay and shrink see exactly what ran.
 */
export const REIFY_SETUP: Command[] = [
  { kind: "action", name: "startRun", params: { conversationIndex: 0 } },
  { kind: "action", name: "commitPlan", params: { conversationIndex: 0 } },
  { kind: "action", name: "advance", params: { event: "plan_ready", conversationIndex: 0 } },
];

/** One fast-check command list: real Reify actions mixed with real process faults. */
export function buildReifySequenceArbitrary(
  actions: ReifyActionDefinition[],
  faults: ReifyFaultDefinition[],
  maxLength = 10,
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
  return fc.array(fc.oneof(...choices), { minLength: 2, maxLength }).map((rest) => [...REIFY_SETUP, ...rest]);
}

export function describeCommand(command: Command): string {
  const params = Object.entries(command.params)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
  return `${command.kind}:${command.name}${params ? `(${params})` : ""}`;
}
