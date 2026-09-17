import type { RuntimePhase, RuntimeStatus, RuntimeTerminalReason } from "@shared/contracts";

/** Below this a silent gap is too short to be worth a reading. */
const SILENT_VISIBLE_MS = 5_000;

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
  /** The runtime's terminal reason, once the turn is over. */
  reason?: RuntimeTerminalReason;
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
  // Only the runtime decides a turn is over. A terminal phase name is not
  // enough: while a provider failure waits out its retry grace the runtime
  // holds `failed` / `provider_timeout` / `reasoning_limit` and the turn is
  // still alive, so the row must stay live instead of flashing a terminal.
  const reason = status.terminalReason ?? turn.terminalReason;
  const terminal = Boolean(turn.finishedAt) || Boolean(reason);
  // A completed turn ends in the answer text; only abnormal ends keep a row.
  if (terminal && reason === "completed") return undefined;
  const end = turn.finishedAt || now;
  // `silent` asks how long the provider has been quiet, so it reads the
  // provider clock. `lastEventAt` also moves for runtime chatter
  // (`agent_status`, `session_action_update`), which would reset the reading
  // while the model is still silent. Journals written before the runtime kept
  // the two clocks apart have no `lastProviderEventAt`, so they fall back to
  // the coarse timestamp.
  const providerEventAt = turn.lastProviderEventAt ?? status.lastProviderEventAt ?? turn.lastEventAt;
  const silentMs = Math.max(0, end - providerEventAt);
  return {
    phase,
    label: phaseLabel({ ...status, phase }),
    terminal,
    reason,
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
