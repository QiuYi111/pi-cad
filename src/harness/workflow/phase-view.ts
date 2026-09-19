import type { WorkflowCurrentView } from "../card.ts";
import type { HarnessRunStateV7 } from "../state.ts";
import type { WorkflowSnapshotV1 } from "./types.ts";

export interface WorkflowPhaseStateView {
  id: string;
  title: string;
  purpose: string;
  status: "complete" | "active" | "pending" | "blocked" | "skipped";
  transitions: Array<{ event: string; target: string }>;
  capabilities: string[];
  obligations: string[];
}

export interface WorkflowRunStateView {
  updatedAt: string;
  phaseHistory: string[];
  phases: WorkflowPhaseStateView[];
}

const BLOCKING_STATUSES = new Set(["blocked_user", "blocked_external", "waiting_user", "aborted"]);

/**
 * The phase picture of one run: which phases exist, which are done, and which
 * one the run is in. Every client that renders workflow state — the Agent API
 * `workflow-current` answer a Desktop conversation reads, and the workspace
 * status projection written for humans — reads this one derivation, so no
 * client has to infer phase statuses from the current phase or from message
 * history.
 */
export function workflowRunStateView(
  run: { state: HarnessRunStateV7; workflow: WorkflowSnapshotV1 },
  view: WorkflowCurrentView,
): WorkflowRunStateView {
  const { state, workflow } = run;
  const terminal = state.status === "done";
  const phases = Object.entries(workflow.phases).map(([id, phase]): WorkflowPhaseStateView => {
    const current = id === state.phase;
    return {
      id,
      title: id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      purpose: phase.purpose,
      status: current
        ? terminal ? "complete" : BLOCKING_STATUSES.has(state.status) ? "blocked" : "active"
        : state.phaseHistory.includes(id) ? "complete" : terminal || state.status === "aborted" ? "skipped" : "pending",
      transitions: current
        ? view.transitions.map((item) => ({ event: item.event, target: item.target }))
        : Object.entries(phase.transitions).map(([event, transition]) => ({ event, target: transition.target })),
      capabilities: current ? view.operations.map((item) => item.capability) : [],
      obligations: current ? [...view.unmet] : [],
    };
  });
  return { updatedAt: state.updatedAt, phaseHistory: [...state.phaseHistory], phases };
}
