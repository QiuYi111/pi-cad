import type { CadRunState, InteractionMode } from "../shared/protocol.ts";

export { interactionModeFromEnvironment } from "../shared/interaction-mode.ts";

/** Legacy v4 runs predate the field and are conservatively interactive. */
export function interactionModeOf(state: Pick<CadRunState, "interactionMode">): InteractionMode {
  return state.interactionMode ?? "interactive";
}

export function isHeadless(state: Pick<CadRunState, "interactionMode">): boolean {
  return interactionModeOf(state) === "headless";
}

export function isTerminalStatus(status: CadRunState["status"]): boolean {
  return status === "done" || status === "aborted" ||
    status === "blocked_user" || status === "blocked_external" ||
    status === "budget_exhausted";
}
