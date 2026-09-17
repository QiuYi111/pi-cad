import type { RuntimePhase, RuntimeStatus } from "@shared/contracts";

/** Below this a silent gap is too short to be worth a reading. */
const SILENT_VISIBLE_MS = 5_000;

const TERMINAL_PHASES = new Set<RuntimePhase>(["aborted", "reasoning_limit", "provider_timeout", "rpc_timeout", "failed"]);

/**
 * Name the phase the runtime reported. Every value comes from `RuntimeStatus`;
 * nothing here inspects Prime events or elapsed time.
 */
export function phaseLabel(status: RuntimeStatus): string {
  switch (status.phase) {
    case "starting_turn": return "Starting turn";
    case "waiting_provider": return "Waiting for model";
    case "thinking": return "Thinking";
    case "responding": return "Responding";
    case "running_tool": return "Running tool";
    case "compacting": return "Compacting";
    case "retrying": return status.retry ? `Retrying ${status.retry.attempt}/${status.retry.maxAttempts}` : "Retrying";
    case "provider_wait": return "Waiting for provider";
    case "stalled": return "No provider response";
    case "stopping": return "Stopping";
    case "aborted": return "Stopped";
    case "reasoning_limit": return "Reasoning limit";
    case "provider_timeout": return "Provider timeout";
    case "rpc_timeout": return "Runtime RPC timeout";
    case "failed": return "Failed";
    case "ready": return status.state === "streaming" ? "Working" : "Ready";
    default: return status.state === "ready" || status.state === "streaming" ? "Ready" : status.state;
  }
}

export function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3_600)}h ${String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0")}m`;
}

export interface TurnPhaseView {
  phase: RuntimePhase;
  label: string;
  terminal: boolean;
  turnSeconds: number;
  phaseSeconds: number;
  silentSeconds: number;
  showSilent: boolean;
}

export interface TurnTimerPart {
  key: "phase" | "silent" | "turn";
  text: string;
}

/**
 * Project the runtime turn. Every clock is read from the runtime turn record:
 * `phase` is the current phase, `silent` is the age of the newest provider
 * event, `turn` is the whole turn. The turn clock is never presented as
 * reasoning activity.
 */
export function turnPhaseView(status: RuntimeStatus, now: number): TurnPhaseView | undefined {
  const turn = status.turn;
  if (!turn) return undefined;
  const phase = status.phase ?? turn.phase;
  const terminal = Boolean(turn.finishedAt) || TERMINAL_PHASES.has(phase);
  // A completed turn ends in the answer text; only abnormal ends keep a row.
  if (terminal && status.terminalReason === "completed") return undefined;
  const end = turn.finishedAt || now;
  const silentMs = Math.max(0, end - turn.lastEventAt);
  return {
    phase,
    label: phaseLabel({ ...status, phase }),
    terminal,
    turnSeconds: Math.max(0, (end - turn.startedAt) / 1_000),
    phaseSeconds: Math.max(0, (end - turn.phaseStartedAt) / 1_000),
    silentSeconds: silentMs / 1_000,
    showSilent: !terminal && silentMs >= SILENT_VISIBLE_MS,
  };
}

/** Every clock is labelled, so the turn total can never read as reasoning time. */
export function turnTimerParts(view: TurnPhaseView): TurnTimerPart[] {
  if (view.terminal) return [];
  const parts: TurnTimerPart[] = [{ key: "phase", text: `phase ${formatSeconds(view.phaseSeconds)}` }];
  if (view.showSilent) parts.push({ key: "silent", text: `silent ${formatSeconds(view.silentSeconds)}` });
  parts.push({ key: "turn", text: `turn ${formatSeconds(view.turnSeconds)}` });
  return parts;
}
