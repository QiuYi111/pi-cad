import type {
  RuntimeRetryStatus,
  RuntimeState,
  RuntimeStatus,
  RuntimeTerminalReason,
  RuntimeTurnStatus,
} from "../../src/shared/contracts.js";
import { classifyTerminalReason, isBlankNeedsInput, runtimeTerminalMessage } from "../../src/shared/contracts.js";

/** How long a requested stop may stay unconfirmed before the process is stopped. */
export const ABORT_CONFIRM_TIMEOUT_MS = 2_500;

export interface RuntimeTraceEntry {
  at: string;
  phase: RuntimeState;
  event: string;
  turnId?: string;
  detail?: string;
}

interface ActiveTurn {
  turnId: string;
  startedAt: number;
  firstProviderEventAt?: number;
  lastProviderEventAt?: number;
  retryAttempts: number;
  retry?: RuntimeRetryStatus;
  abortRequestedAt?: number;
  abortConfirmedAt?: number;
  observedReason?: RuntimeTerminalReason;
  endedAt?: number;
}

/** Events that are worth a journal line even though the phase does not change. */
const TRACED_EVENTS = new Set([
  "turn_end",
  "compaction_start",
  "compaction_end",
  "session_action_update",
  "extension_error",
  "agent_error",
  "runtime_diagnostic",
]);

/** Local ISO-8601 with the machine's UTC offset, so logs read like the lab clock. */
export function localIso(millis: number): string {
  const date = new Date(millis);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function textOf(value: unknown, limit = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const SETTLED: RuntimeState[] = ["ready", "failed", "aborted", "error"];

export function runtimeStateSettled(state: RuntimeState): boolean {
  return SETTLED.includes(state);
}

/**
 * Projects the Prime event stream onto the runtime state machine and keeps the
 * turn evidence (timings, retries, terminal reason) that the UI and the journal
 * both read.
 */
export class PrimeRuntimeState {
  private phase: RuntimeState;
  private lifecycleMessage?: string;
  private active: ActiveTurn | null = null;
  private lastTurn: RuntimeTurnStatus | null = null;
  private entries: RuntimeTraceEntry[] = [];

  constructor(initial: RuntimeState = "idle") {
    this.phase = initial;
  }

  get state(): RuntimeState {
    return this.phase;
  }

  get turn(): RuntimeTurnStatus | undefined {
    if (this.active) return this.turnSnapshot(this.active);
    return this.lastTurn ?? undefined;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** Process-level states: idle, checking, installing, starting, ready, error. */
  lifecycle(state: RuntimeState, message?: string, at = Date.now()): boolean {
    this.lifecycleMessage = message;
    this.active = null;
    return this.transition(state, at, `lifecycle:${state}`, message);
  }

  /** A prompt or steer request was accepted; the turn starts before agent_start. */
  expectTurn(at = Date.now(), source = "prompt"): boolean {
    const started = this.ensureTurn(at);
    const changed = this.transition(this.phase === "stopping" ? "stopping" : "waiting_provider", at, `${source}_accepted`);
    return started || changed;
  }

  apply(event: any, at = Date.now()): boolean {
    const type = typeof event?.type === "string" ? event.type : "";
    switch (type) {
      case "agent_start":
      case "turn_start":
        return this.beginRequest(at, type);
      case "message_start":
        return event?.message?.role === "assistant" ? this.beginRequest(at, "message_start") : false;
      case "message_update": {
        const first = this.noteProviderEvent(at);
        const advanced = this.phase !== "running" && this.phase !== "stopping"
          ? this.transition("running", at, "message_update")
          : false;
        return first || advanced;
      }
      case "auto_retry_start":
        return this.retryStarted(event, at);
      case "auto_retry_end":
        return this.retryEnded(event, at);
      case "message_end":
        return this.messageEnded(event, at);
      case "agent_end":
        return this.turnEnded(at);
      case "agent_abort":
      case "abort":
        return this.confirmAbort(at, type);
      case "agent_error":
        return this.providerFailed(at, textOf(event?.message, 200) ?? "Agent error");
      case "agent_status":
        return this.agentStatus(event, at);
      case "runtime_exit":
        return this.runtimeExit(textOf(event?.message, 200) ?? "Runtime exited", at);
      default:
        if (TRACED_EVENTS.has(type)) this.record(type, at, textOf(event?.message, 200));
        return false;
    }
  }

  requestAbort(at = Date.now()): boolean {
    if (this.active) this.active.abortRequestedAt ??= at;
    return this.transition("stopping", at, "abort_requested", "waiting for the runtime to confirm the stop");
  }

  /** The stop is real once Prime reports an aborted message / abort / agent_end. */
  confirmAbort(at = Date.now(), source = "abort"): boolean {
    const turn = this.active;
    if (!turn) {
      if (this.phase !== "stopping") {
        this.record("abort_ignored", at, `${source} without an active turn`);
        return false;
      }
      return this.transition("ready", at, `${source}_confirmed`, "nothing was running");
    }
    turn.abortConfirmedAt ??= at;
    turn.observedReason = "aborted";
    return this.transition("stopping", at, `${source}_confirmed`);
  }

  runtimeExit(message: string, at = Date.now()): boolean {
    if (this.active) {
      this.active.observedReason = "runtime_exit";
      this.active.endedAt = at;
      this.lastTurn = this.turnSnapshot(this.active);
      this.active = null;
    } else {
      this.lastTurn = { turnId: this.lastTurn?.turnId ?? `runtime-${at}`, startedAt: localIso(at), retryAttempts: 0, terminalReason: "runtime_exit", endedAt: localIso(at) };
    }
    this.lifecycleMessage = message;
    return this.transition("error", at, "runtime_exit", message);
  }

  drain(): RuntimeTraceEntry[] {
    return this.entries.splice(0, this.entries.length);
  }

  status(): Pick<RuntimeStatus, "state" | "message" | "turn"> {
    const message = this.phaseMessage();
    return { state: this.phase, ...(message ? { message } : {}), ...(this.turn ? { turn: this.turn } : {}) };
  }

  private phaseMessage(): string | undefined {
    switch (this.phase) {
      case "waiting_provider": return "Waiting for the model…";
      case "retrying": {
        const retry = this.active?.retry;
        return retry
          ? `Retrying after a transient error (attempt ${retry.attempt}${retry.maxAttempts ? ` of ${retry.maxAttempts}` : ""}).`
          : "Retrying after a transient error.";
      }
      case "stopping": return "Stopping the current task…";
      case "aborted": return "Task stopped.";
      case "failed": return runtimeTerminalMessage(this.lastTurn?.terminalReason ?? "provider_error");
      default: return this.lifecycleMessage;
    }
  }

  private beginRequest(at: number, source: string): boolean {
    const started = this.ensureTurn(at);
    if (this.phase === "stopping") return started;
    const changed = this.transition("waiting_provider", at, source);
    return started || changed;
  }

  private retryStarted(event: any, at: number): boolean {
    this.ensureTurn(at);
    const turn = this.active!;
    const attempt = numberOf(event?.attempt) ?? turn.retryAttempts + 1;
    const maxAttempts = numberOf(event?.maxAttempts);
    const delayMs = numberOf(event?.delayMs);
    const reason = textOf(event?.errorMessage) ?? "transient provider error";
    turn.retryAttempts += 1;
    turn.retry = { attempt, ...(maxAttempts === undefined ? {} : { maxAttempts }), ...(delayMs === undefined ? {} : { delayMs }), reason, requestedAt: localIso(at) };
    this.transition("retrying", at, "auto_retry_start", `attempt ${attempt}${maxAttempts ? ` of ${maxAttempts}` : ""}${delayMs === undefined ? "" : ` in ${delayMs}ms`}: ${reason}`);
    return true;
  }

  private retryEnded(event: any, at: number): boolean {
    this.ensureTurn(at);
    const turn = this.active!;
    if (event?.success === false) {
      turn.observedReason ??= "provider_error";
      this.record("auto_retry_end", at, `retry exhausted: ${textOf(event?.finalError) ?? turn.retry?.reason ?? "unknown"}`);
      return true;
    }
    this.transition("waiting_provider", at, "auto_retry_end", `attempt ${numberOf(event?.attempt) ?? turn.retryAttempts} recovered`);
    return true;
  }

  private messageEnded(event: any, at: number): boolean {
    const message = event?.message;
    if (message?.role !== "assistant") return false;
    const reason = classifyTerminalReason(message);
    const turn = this.active;
    if (!turn) {
      this.record("message_end", at, `assistant ${textOf(message?.stopReason, 40) ?? "unknown"} without an active turn`);
      if (reason === "aborted" && this.phase === "stopping") return this.transition("aborted", at, "aborted_message", "Prime confirmed the stop");
      return false;
    }
    if (reason === "aborted") {
      turn.observedReason = "aborted";
      turn.abortConfirmedAt ??= at;
      return this.transition("stopping", at, "aborted_message", "Prime confirmed the stop");
    }
    if (reason && reason !== "completed") {
      turn.observedReason = reason;
      this.record("provider_failure", at, `${reason}: ${textOf(message?.errorMessage, 200) ?? "no message"}`);
      return true;
    }
    // The last assistant message of a turn owns the outcome: a retried request
    // that finally answered replaces the provisional failure before it.
    turn.observedReason = reason ?? "completed";
    return false;
  }

  private providerFailed(at: number, detail: string): boolean {
    const turn = this.active;
    if (!turn) return this.transition("failed", at, "agent_error", detail);
    turn.observedReason = "provider_error";
    this.record("provider_failure", at, detail);
    // A rejection before the first provider event never produced a run, so the
    // turn settles here instead of waiting for an agent_end that will not come.
    return turn.firstProviderEventAt === undefined ? this.turnEnded(at) : true;
  }

  private agentStatus(event: any, at: number): boolean {
    if (isBlankNeedsInput(event)) {
      this.record("agent_status_ignored", at, "empty needs_input carries no question");
      return false;
    }
    this.record("agent_status", at, textOf(event?.status?.summary ?? event?.summary, 200));
    return false;
  }

  private turnEnded(at: number): boolean {
    const turn = this.active;
    if (!turn) {
      const next: RuntimeState = this.phase === "stopping" ? "aborted" : this.phase === "error" ? "error" : "ready";
      return this.transition(next, at, "agent_end");
    }
    const reason = turn.observedReason === "aborted" || turn.abortRequestedAt !== undefined
      ? "aborted"
      : turn.observedReason ?? "completed";
    if (reason === "aborted") turn.abortConfirmedAt ??= at;
    turn.observedReason = reason;
    turn.endedAt = at;
    this.lastTurn = this.turnSnapshot(turn);
    this.active = null;
    const next: RuntimeState = reason === "aborted" ? "aborted" : reason === "completed" ? "ready" : "failed";
    this.record("turn_settled", at, `terminal ${reason}${turn.retryAttempts ? ` after ${turn.retryAttempts} retries` : ""}`);
    return this.transition(next, at, "agent_end", reason === "completed" ? undefined : runtimeTerminalMessage(reason));
  }

  private noteProviderEvent(at: number): boolean {
    this.ensureTurn(at);
    const turn = this.active!;
    if (turn.firstProviderEventAt !== undefined) {
      turn.lastProviderEventAt = at;
      return false;
    }
    turn.firstProviderEventAt = at;
    turn.lastProviderEventAt = at;
    this.record("first_provider_event", at, "model stream started");
    return true;
  }

  private ensureTurn(at: number): boolean {
    if (this.active) return false;
    this.active = { turnId: `turn-${at}`, startedAt: at, retryAttempts: 0 };
    this.record("turn_started", at, "turn opened");
    return true;
  }

  private turnSnapshot(turn: ActiveTurn): RuntimeTurnStatus {
    return {
      turnId: turn.turnId,
      startedAt: localIso(turn.startedAt),
      ...(turn.firstProviderEventAt === undefined ? {} : { firstProviderEventAt: localIso(turn.firstProviderEventAt) }),
      ...(turn.lastProviderEventAt === undefined ? {} : { lastProviderEventAt: localIso(turn.lastProviderEventAt) }),
      retryAttempts: turn.retryAttempts,
      ...(turn.retry ? { retry: turn.retry } : {}),
      ...(turn.abortRequestedAt === undefined ? {} : { abortRequestedAt: localIso(turn.abortRequestedAt) }),
      ...(turn.abortConfirmedAt === undefined ? {} : { abortConfirmedAt: localIso(turn.abortConfirmedAt) }),
      ...(turn.observedReason ? { terminalReason: turn.observedReason } : {}),
      ...(turn.endedAt === undefined ? {} : { endedAt: localIso(turn.endedAt) }),
    };
  }

  private transition(next: RuntimeState, at: number, event: string, detail?: string): boolean {
    const changed = next !== this.phase;
    this.phase = next;
    this.record(event, at, detail);
    return changed;
  }

  private record(event: string, at: number, detail?: string): void {
    this.entries.push({
      at: localIso(at),
      phase: this.phase,
      event,
      ...(this.active ? { turnId: this.active.turnId } : {}),
      ...(detail ? { detail } : {}),
    });
  }
}

export interface AbortConfirmationDeps {
  requestAbort: () => Promise<void>;
  waitForSettle: (timeoutMs: number) => Promise<boolean>;
  escalate: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Stop is only confirmed by a real terminal event. An unanswered stop escalates
 * to a process-level stop instead of reporting the turn as finished.
 */
export async function awaitAbortConfirmation(deps: AbortConfirmationDeps): Promise<"confirmed" | "escalated"> {
  const timeoutMs = deps.timeoutMs ?? ABORT_CONFIRM_TIMEOUT_MS;
  const confirmation = deps.waitForSettle(timeoutMs);
  await deps.requestAbort().catch(() => undefined);
  if (await confirmation) return "confirmed";
  await deps.escalate();
  return "escalated";
}
