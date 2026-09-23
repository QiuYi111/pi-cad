import fc from "fast-check";
import type { ActionDefinition, FaultDefinition } from "../types.ts";

export interface Command {
  kind: "action" | "fault";
  name: string;
  params: Record<string, unknown>;
}

function toArbitrary(kind: Command["kind"], definition: ActionDefinition | FaultDefinition, weight: number) {
  return {
    arbitrary: definition.arbitrary.map((params): Command => ({ kind, name: definition.name, params })),
    weight,
  };
}

const ACTION_WEIGHTS: Record<string, number> = {
  createProject: 3,
  createRun: 6,
  startWorker: 7,
  stopWorker: 2,
  cancelRun: 1,
  restartWorker: 2,
  refresh: 1,
  continueRun: 3,
  clearFaults: 2,
  settle: 1,
};

const FAULT_WEIGHTS: Record<string, number> = {
  killWorker: 6,
  pauseWorker: 3,
  externalLatency: 3,
  externalDisconnect: 2,
  externalDown: 1,
};

export function buildSequenceArbitrary(
  actions: ActionDefinition[],
  faults: FaultDefinition[],
  maxLength = 12,
): fc.Arbitrary<Command[]> {
  const arbitrariness = [
    ...actions.map((definition) => toArbitrary("action", definition, ACTION_WEIGHTS[definition.name] ?? 1)),
    ...faults.map((definition) => toArbitrary("fault", definition, FAULT_WEIGHTS[definition.name] ?? 1)),
  ];
  return fc.array(fc.oneof(...arbitrariness), { minLength: 5, maxLength });
}

export function describeCommand(command: Command): string {
  const params = Object.entries(command.params)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
  return `${command.kind}:${command.name}${params ? `(${params})` : ""}`;
}
