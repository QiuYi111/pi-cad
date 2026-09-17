import type {
  RuntimePhase,
  RuntimeRetry,
  RuntimeStatus,
  RuntimeTerminalReason,
  RuntimeTurn,
} from "../../src/shared/contracts.js";

/**
 * Prime RPC runtime state machine.
 *
 * Prime streams raw agent events (`agent_start`, `message_update`,
 * `auto_retry_start`, ...). The desktop keeps one authoritative status for the
 * renderer: a coarse `state`, a fine-grained `phase`, the active turn record,
 * and a terminal reason that later stale events cannot overwrite.
 */

/** Phases that mean "a provider request is in flight". */
export const MODEL_WAIT_PHASES: readonly RuntimePhase[] = [
  "starting_turn",
  "waiting_provider",
  "provider_wait",
  "thinking",
  "responding",
];

/**
 * Events that prove the provider request is still alive.
 *
 * `agent_status`, `session_action_update` and other runtime chatter keep
 * arriving while the model is silent, so they must not feed the stall
 * watchdog: only these stream/model events reset the provider clock.
 */
const PROVIDER_EVENT_TYPES = new Set([
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
]);

function isProviderEvent(event: any): boolean {
  const type = event?.type;
  if (type === "turn_start" || type === "message_start") return event?.message?.role !== "user";
  return typeof type === "string" && PROVIDER_EVENT_TYPES.has(type);
}

/**
 * Terminal precedence. A failed turn may be escalated (abort while stopping,
 * sidecar death after an abort) but never downgraded: `aborted` must not turn
 * back into `provider_error`, and a late `completed` must not clear a failure.
 */
export const TERMINAL_PRIORITY: Record<RuntimeTerminalReason, number> = {
  completed: 1,
  rpc_rejected: 2,
  rpc_timeout: 2,
  provider_error: 3,
  provider_timeout: 4,
  reasoning_limit: 5,
  aborted: 6,
  process_exit: 8,
  forced_stop: 9,
};

const TERMINAL_PHASE: Record<RuntimeTerminalReason, RuntimePhase> = {
  completed: "ready",
  rpc_rejected: "failed",
  rpc_timeout: "rpc_timeout",
  provider_error: "failed",
  provider_timeout: "provider_timeout",
  reasoning_limit: "reasoning_limit",
  aborted: "aborted",
  process_exit: "failed",
  forced_stop: "failed",
};

export interface ProviderFailure {
  terminalReason: RuntimeTerminalReason;
  reason: string;
}

/**
 * One replayable line of the runtime journal. The desktop appends these to
 * `<project>/.pi-cad/desktop-runtime.jsonl` so a stalled, retried or aborted
 * run can be reconstructed after the fact.
 */
export interface RuntimeTraceEntry {
  /** Local ISO-8601 with the machine's UTC offset, so the log matches the wall clock. */
  at: string;
  phase: RuntimePhase;
  event: string;
  turnId?: string;
  detail?: string;
}

/** Local ISO-8601 with the machine's UTC offset, so logs read like the lab clock. */
export function localIso(millis: number): string {
  const date = new Date(millis);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function traceDetail(value: unknown, limit = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

/** Map a provider/SDK error message to one distinguishable terminal reason. */
export function classifyProviderFailure(message?: string): ProviderFailure {
  const text = String(message ?? "").toLowerCase();
  if (/retry cancelled|abort(ed)? by|user (abort|stop)|interrupted by user/.test(text)) {
    return { terminalReason: "aborted", reason: "user_abort" };
  }
  if (/reasoning|thinking/.test(text) && /(budget|limit|exhaust|exceed)/.test(text)) {
    return { terminalReason: "reasoning_limit", reason: "reasoning_limit" };
  }
  if (/timeout|timed out/.test(text)) {
    return { terminalReason: "provider_timeout", reason: "provider_timeout" };
  }
  if (/\b429\b|rate.?limit|quota/.test(text)) {
    return { terminalReason: "provider_error", reason: "rate_limit" };
  }
  if (/\b401\b|\b403\b|auth|credential|unauthori[sz]ed|forbidden/.test(text)) {
    return { terminalReason: "provider_error", reason: "authentication" };
  }
  if (/context|token.*limit|too long|maximum.*length|length limit|output limit/.test(text)) {
    return { terminalReason: "provider_error", reason: "context_limit" };
  }
  if (/network|socket|connection|fetch|stream closed|disconnected/.test(text)) {
    return { terminalReason: "provider_error", reason: "network" };
  }
  if (/\b5\d\d\b|overload|unavailable/.test(text)) {
    return { terminalReason: "provider_error", reason: "provider_unavailable" };
  }
  return { terminalReason: "provider_error", reason: "provider_error" };
}

/**
 * Explicit evidence that the model stopped because its thinking/reasoning budget
 * ran out.
 *
 * `stopReason === "length"` alone is not enough: an answer cut at the output
 * limit looks the same. Require either error text that names the reasoning
 * budget, or a response that was still thinking and never produced an answer.
 */
export function reasoningLimitEvidence(message: any): string | undefined {
  const text = `${message?.errorMessage ?? ""} ${message?.rawStopReason ?? ""}`.toLowerCase();
  if (/reasoning|thinking|thought/.test(text) && /(budget|limit|exhaust|exceed|cap|truncat)/.test(text)) {
    return "reasoning_budget";
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  const answered = content.some((part: any) => part?.type === "text" || part?.type === "toolCall");
  const last = content[content.length - 1];
  if (!answered && last?.type === "thinking") return "thinking_truncated";
  return undefined;
}

/**
 * Terminal meaning of an assistant message, if it ended the turn.
 *
 * `error` carries the provider failure. `length` is only a reasoning limit when
 * there is evidence the thinking budget ran out; a plain answer that hit the
 * output limit is not a failure, so the caller reports it as `output_limit`.
 */
export function classifyMessageEnd(message: any): ProviderFailure | undefined {
  const stopReason = message?.stopReason;
  if (stopReason === "aborted") return { terminalReason: "aborted", reason: "user_abort" };
  if (stopReason === "error") return classifyProviderFailure(message?.errorMessage);
  // Newer Prime cores end the message with this stop reason directly instead of
  // reporting `length` plus a hint, so it is its own terminal outcome.
  if (stopReason === "reasoning_limit") return { terminalReason: "reasoning_limit", reason: "reasoning_limit" };
  if (stopReason === "length") {
    const evidence = reasoningLimitEvidence(message);
    return evidence ? { terminalReason: "reasoning_limit", reason: evidence } : undefined;
  }
  return undefined;
}

export function lastAssistantMessage(messages: unknown): any {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as any;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export interface PrimeRuntimeStateOptions {
  now?: () => number;
  /** How long a provider error is held before it becomes a terminal failure. */
  failureGraceMs?: number;
}

/**
 * Owns the authoritative {@link RuntimeStatus}. Mutating methods return
 * nothing; callers compare `state.status` identity to decide whether to emit.
 */
export class PrimeRuntimeState {
  status: RuntimeStatus;
  readonly failureGraceMs: number;
  private readonly now: () => number;
  private pending?: { terminalReason: RuntimeTerminalReason; reason: string; message?: string };
  private sequence = 0;
  private readonly entries: RuntimeTraceEntry[] = [];
  private providerEventAt?: number;

  constructor(initial: RuntimeStatus = { state: "idle", checks: [] }, options: PrimeRuntimeStateOptions = {}) {
    this.status = initial;
    this.now = options.now ?? Date.now;
    this.failureGraceMs = options.failureGraceMs ?? 1_500;
  }

  /** A provider failure that may still be superseded by an automatic retry. */
  get failurePending(): boolean {
    return this.pending !== undefined;
  }

  activeTurn(): RuntimeTurn | undefined {
    const turn = this.status.turn;
    return turn && !turn.terminalReason ? turn : undefined;
  }

  /**
   * Newest provider/model stream event. The stall watchdog anchors here instead
   * of `lastEventAt`, which every runtime event (including `agent_status`) moves.
   */
  get lastProviderEventAt(): number | undefined {
    return this.providerEventAt;
  }

  /** Take the journal lines recorded since the last call; the caller persists them. */
  drain(): RuntimeTraceEntry[] {
    return this.entries.splice(0, this.entries.length);
  }

  /** Merge lifecycle fields produced outside the turn (setup, install, start, stop). */
  base(patch: Partial<RuntimeStatus>): void {
    const next: RuntimeStatus = { ...this.status, ...patch };
    if (patch.state === "idle" && !this.activeTurn()) {
      this.providerEventAt = undefined;
      this.status = {
        ...next,
        phase: undefined,
        reason: undefined,
        terminalReason: undefined,
        turn: undefined,
        retry: undefined,
        lastEventAt: undefined,
        lastProviderEventAt: undefined,
      };
      return;
    }
    if (!this.activeTurn()) {
      if (patch.state === "error" && !this.status.turn) next.phase = "failed";
      else if (patch.state === "ready" && !next.phase) next.phase = "ready";
    }
    this.status = next;
  }

  /** A prompt or steer request was accepted by the desktop and sent to Prime. */
  beginTurn(kind: "prompt" | "steer", id?: string): void {
    if (this.activeTurn()) return;
    const now = this.now();
    const turn: RuntimeTurn = {
      id: id ?? `turn-${++this.sequence}`,
      kind,
      startedAt: now,
      phaseStartedAt: now,
      lastEventAt: now,
      lastProviderEventAt: now,
      retryAttempt: 0,
      phase: "starting_turn",
      reason: "prompt_sent",
    };
    this.providerEventAt = now;
    this.pending = undefined;
    this.status = {
      ...this.status,
      state: "streaming",
      phase: "starting_turn",
      reason: "prompt_sent",
      message: undefined,
      terminalReason: undefined,
      retry: undefined,
      turn,
      lastEventAt: now,
      lastProviderEventAt: now,
    };
    this.record("turn_started", `${kind} accepted`);
  }

  /** Apply one raw Prime RPC event. All events are JSON records from stdout. */
  applyEvent(event: any): void {
    const type = event?.type;
    if (typeof type !== "string") return;
    if (type === "agent_start") {
      this.startOrResumeTurn();
      return;
    }
    if (!this.activeTurn() && !this.failurePending) return;
    if (isProviderEvent(event)) this.markProviderEvent();
    switch (type) {
      case "turn_start":
      case "message_start":
        if (event.message?.role === "user") break;
        this.phase("waiting_provider", { reason: "provider_request" });
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent ?? {};
        if (delta.type === "thinking_start" || delta.type === "thinking_delta") this.phase("thinking", { reason: "reasoning" });
        else if (delta.type === "text_start" || delta.type === "text_delta") this.phase("responding", { reason: "answering" });
        else if (typeof delta.type === "string" && delta.type.startsWith("toolcall")) this.phase("responding", { reason: "tool_call" });
        else if (delta.type === "error") {
          // The error body lives on the stream event; `message` is only the partial.
          const failed = delta.error ?? event.message;
          if (delta.reason === "aborted" || failed?.stopReason === "aborted") this.finish("aborted", { reason: "user_abort" });
          else this.noteFailure(failed?.errorMessage ?? event.message?.errorMessage, classifyMessageEnd(failed));
        } else if (delta.type === "start") this.phase("waiting_provider", { reason: "provider_request" });
        else this.touch();
        break;
      }
      case "message_end": {
        if (event.message?.role !== "assistant") break;
        const failure = classifyMessageEnd(event.message);
        if (failure) this.noteFailure(event.message?.errorMessage, failure);
        else {
          this.touch(event.message?.stopReason === "length" ? "output_limit" : undefined);
          this.record("message_end", traceDetail(event.message?.stopReason));
        }
        break;
      }
      case "tool_execution_start":
        this.phase("running_tool", { reason: event.toolName ? String(event.toolName) : "tool" });
        break;
      case "tool_execution_update":
        this.phase("running_tool", { reason: event.stage || this.status.reason });
        break;
      case "tool_execution_end":
        this.phase("waiting_provider", { reason: "provider_request" });
        break;
      case "auto_retry_start": {
        const failure = classifyProviderFailure(event.errorMessage);
        this.pending = undefined;
        const attempt = Number(event.attempt) || 1;
        const retry: RuntimeRetry = {
          attempt,
          maxAttempts: Number(event.maxAttempts) || attempt,
          delayMs: Number(event.delayMs) || 0,
          reason: failure.reason,
          message: event.errorMessage ? String(event.errorMessage) : undefined,
        };
        this.phase("retrying", { reason: failure.reason, retry, retryAttempt: attempt });
        break;
      }
      case "auto_retry_end":
        this.pending = undefined;
        if (event.success) this.phase("provider_wait", { reason: "retry_succeeded", retry: null });
        else {
          const message = String(event.finalError ?? "Prime exhausted automatic retries");
          this.noteFailure(message, classifyProviderFailure(message));
        }
        break;
      case "compaction_start":
        this.phase("compacting", { reason: event.reason ? String(event.reason) : "compaction" });
        break;
      case "compaction_end":
        if (event.errorMessage) this.noteFailure(String(event.errorMessage));
        else this.phase("provider_wait", { reason: event.aborted ? "compaction_aborted" : "compaction_done" });
        break;
      case "agent_abort":
      case "abort":
        this.finish("aborted", { reason: "user_abort" });
        break;
      case "agent_error": {
        const message = event.error?.message ?? event.message ?? event.error ?? "Prime agent failed";
        this.pending = undefined;
        this.finish("provider_error", { reason: "agent_error", message: String(message) });
        break;
      }
      case "agent_end": {
        if (this.status.phase === "stopping") {
          this.finish("aborted", { reason: "user_abort" });
          break;
        }
        const last = lastAssistantMessage(event.messages);
        const failure = classifyMessageEnd(last);
        if (failure) this.noteFailure(last?.errorMessage, failure);
        else this.finish("completed", { reason: last?.stopReason === "length" ? "output_limit" : "turn_complete" });
        break;
      }
      case "extension_error":
        if (this.activeTurn()) {
          this.status = {
            ...this.status,
            reason: "extension_error",
            message: String(event.error ?? "Prime extension failed"),
          };
          this.record("event:extension_error", traceDetail(event.error));
        }
        break;
      case "agent_status":
        // Prime reports its own verdict next to the runtime phases; keep it as
        // evidence without letting it move the phase the state machine owns.
        this.record("event:agent_status", traceDetail(event.status?.summary ?? event.summary));
        this.touch();
        break;
      case "session_action_update":
        this.touch();
        break;
      default:
        this.touch();
        break;
    }
  }

  /** The scheduled retry delay elapsed: the retry attempt is now in flight. */
  retryDelayElapsed(attempt: number): void {
    if (this.status.phase !== "retrying") return;
    if (Number(this.status.retry?.attempt) !== Number(attempt)) return;
    this.phase("provider_wait", { reason: "retry_attempt", retryAttempt: attempt });
  }

  /**
   * No provider-side event for longer than the provider timeout budget.
   *
   * This is a live signal, not a terminal one: Prime still owns the request, a
   * later provider event clears it, and a real `provider_timeout` must come from
   * an explicit provider/SDK timeout instead.
   */
  providerStall(idleMs: number): void {
    if (!this.activeTurn()) return;
    if (!MODEL_WAIT_PHASES.includes(this.status.phase ?? "ready")) return;
    this.phase("stalled", { reason: "provider_silent", message: `No provider response for ${Math.round(idleMs / 1000)}s` });
  }

  /** A Prime RPC command failed before or during the turn. */
  rpcFailure(kind: "rpc_timeout" | "rpc_rejected", message: string): void {
    if (kind === "rpc_rejected") {
      if (this.activeTurn()) this.finish("rpc_rejected", { reason: "request_rejected", message });
      return;
    }
    const turn = this.activeTurn();
    if (!turn) return;
    if (turn.phase === "starting_turn") {
      // No agent work started, so the turn is over: the request timed out.
      this.finish("rpc_timeout", { reason: "rpc_timeout", message });
      return;
    }
    if (turn.phase === "stopping") {
      // The stop handshake is still running; keep its phase and record the
      // transport timeout as the reason.
      this.status = { ...this.status, reason: "rpc_timeout", message };
      this.record("rpc_timeout", message);
      return;
    }
    // Prime may still be working; record the transport timeout without
    // pretending the turn ended.
    this.phase("rpc_timeout", { reason: "rpc_timeout", message });
  }

  /** Stop was requested: Prime is asked to abort and the handshake is running. */
  beginStopping(): void {
    if (!this.activeTurn()) return;
    this.pending = undefined;
    this.phase("stopping", { reason: "stop_requested", state: "stopping" });
  }

  /** The failure grace elapsed without an automatic retry: make it terminal. */
  settleFailure(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.finish(pending.terminalReason, { reason: pending.reason, message: pending.message });
  }

  /**
   * The Prime child process exited.
   *
   * A process lifecycle event must never rewrite a turn that already settled:
   * stopping the runtime normally leaves the last completed turn completed.
   * Only the coarse lifecycle state follows the process, and it follows for
   * every settled outcome so a dead sidecar never looks like a live runtime.
   */
  processExited(code: number | null, signal: string | null, forced = false): void {
    const detail = `Prime exited (${signal || code || 0})`;
    this.pending = undefined;
    this.record("process_exit", detail);
    const settled = this.status.turn?.terminalReason;
    if (settled) {
      if (!forced) {
        this.status = { ...this.status, state: code === 0 ? "idle" : "error", ...(code === 0 ? {} : { message: detail }) };
      }
      return;
    }
    if (forced) {
      this.finish("forced_stop", { reason: "stop_timeout", message: detail, state: "error" });
      return;
    }
    this.finish("process_exit", {
      reason: "process_exit",
      state: code === 0 ? "idle" : "error",
      ...(code === 0 ? {} : { message: detail }),
    });
  }

  /** Prime answered `get_state` (start, session switch, new session). */
  sessionReady(sessionId?: string): void {
    this.pending = undefined;
    this.providerEventAt = undefined;
    this.status = {
      ...this.status,
      state: "ready",
      phase: "ready",
      reason: undefined,
      sessionId: sessionId ?? this.status.sessionId,
      message: undefined,
      retry: undefined,
      terminalReason: undefined,
      turn: undefined,
      lastProviderEventAt: undefined,
    };
    this.record("session_ready", sessionId);
  }

  private startOrResumeTurn(): void {
    const active = this.activeTurn();
    if (active) {
      this.phase("waiting_provider", { reason: "provider_request" });
      return;
    }
    const now = this.now();
    const turn: RuntimeTurn = {
      id: `prime-${++this.sequence}`,
      kind: "prompt",
      startedAt: now,
      phaseStartedAt: now,
      lastEventAt: now,
      lastProviderEventAt: now,
      retryAttempt: 0,
      phase: "waiting_provider",
      reason: "provider_request",
    };
    this.providerEventAt = now;
    this.pending = undefined;
    this.status = {
      ...this.status,
      state: "streaming",
      phase: "waiting_provider",
      reason: "provider_request",
      message: undefined,
      terminalReason: undefined,
      retry: undefined,
      turn,
      lastEventAt: now,
      lastProviderEventAt: now,
    };
    this.record("turn_started", "agent_start");
  }

  private noteFailure(message?: string, classified?: ProviderFailure): void {
    const failure = classified ?? classifyProviderFailure(message);
    const detail = message ?? this.status.message;
    if (failure.terminalReason === "aborted") {
      this.finish("aborted", { reason: failure.reason, message: detail });
      return;
    }
    const now = this.now();
    const phase = TERMINAL_PHASE[failure.terminalReason];
    this.pending = { terminalReason: failure.terminalReason, reason: failure.reason, message: detail };
    const turn = this.activeTurn();
    if (turn) {
      this.status = {
        ...this.status,
        state: "streaming",
        phase,
        reason: failure.reason,
        message: detail,
        turn: { ...turn, phase, phaseStartedAt: turn.phase === phase ? turn.phaseStartedAt : now, lastEventAt: now, reason: failure.reason, error: detail },
        lastEventAt: now,
      };
    }
    this.record(`failure:${failure.reason}`, detail);
  }

  /** Move to a live phase of the active turn. */
  private phase(phase: RuntimePhase, options: { reason?: string; message?: string; state?: RuntimeStatus["state"]; retry?: RuntimeRetry | null; retryAttempt?: number } = {}): void {
    const now = this.now();
    const turn = this.activeTurn();
    if (!turn) return;
    // Entering a model-wait phase from outside one means a new provider request
    // is starting, so the stall watchdog restarts from this moment.
    const providerAt = MODEL_WAIT_PHASES.includes(phase) && !MODEL_WAIT_PHASES.includes(turn.phase) ? now : this.providerEventAt;
    this.providerEventAt = providerAt;
    // Stream deltas re-enter the same phase; only real phase moves get a journal line.
    const changed = turn.phase !== phase
      || (options.reason !== undefined && options.reason !== turn.reason)
      || (options.retryAttempt !== undefined && options.retryAttempt !== turn.retryAttempt);
    const nextTurn: RuntimeTurn = {
      ...turn,
      phase,
      // Same-phase stream deltas keep the original clock: `phaseStartedAt` means
      // "how long this phase has run", not "how long since the last delta".
      phaseStartedAt: turn.phase === phase ? turn.phaseStartedAt : now,
      lastEventAt: now,
      ...(providerAt !== undefined ? { lastProviderEventAt: providerAt } : {}),
      reason: options.reason ?? turn.reason,
      error: options.message ?? turn.error,
      retryAttempt: options.retryAttempt ?? turn.retryAttempt,
    };
    this.status = {
      ...this.status,
      state: options.state ?? (this.status.state === "stopping" ? "stopping" : "streaming"),
      phase,
      reason: options.reason ?? this.status.reason,
      message: options.message ?? this.status.message,
      terminalReason: undefined,
      retry: options.retry === undefined ? this.status.retry : options.retry ?? undefined,
      turn: nextTurn,
      lastEventAt: now,
      ...(providerAt !== undefined ? { lastProviderEventAt: providerAt } : {}),
    };
    if (changed) this.record(`phase:${phase}`, traceDetail(options.message) ?? options.reason);
  }

  /** Remember the newest provider/model stream event. */
  private markProviderEvent(now = this.now()): void {
    this.providerEventAt = now;
    const turn = this.status.turn;
    this.status = {
      ...this.status,
      lastProviderEventAt: now,
      turn: turn ? { ...turn, lastProviderEventAt: now } : turn,
    };
  }

  private touch(reason?: string): void {
    const now = this.now();
    const turn = this.activeTurn();
    if (!turn) return;
    this.status = {
      ...this.status,
      reason: reason ?? this.status.reason,
      lastEventAt: now,
      turn: { ...turn, reason: reason ?? turn.reason, lastEventAt: now },
    };
  }

  private record(event: string, detail?: string): void {
    this.entries.push({
      at: localIso(this.now()),
      phase: this.status.phase ?? "ready",
      event,
      ...(this.status.turn?.id ? { turnId: this.status.turn.id } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  /** Terminal outcome for the current turn. Stale or lower-priority terminals are ignored. */
  private finish(reason: RuntimeTerminalReason, options: { reason?: string; message?: string; state?: RuntimeStatus["state"] } = {}): void {
    const now = this.now();
    const turn = this.status.turn;
    if (turn?.terminalReason && TERMINAL_PRIORITY[turn.terminalReason] >= TERMINAL_PRIORITY[reason]) return;
    const phase = TERMINAL_PHASE[reason];
    if (turn) {
      const finished: RuntimeTurn = {
        ...turn,
        phase,
        phaseStartedAt: turn.phase === phase ? turn.phaseStartedAt : now,
        lastEventAt: now,
        finishedAt: now,
        terminalReason: reason,
        reason: options.reason ?? turn.reason,
        error: options.message ?? turn.error,
      };
      this.status = {
        ...this.status,
        state: options.state ?? "ready",
        phase,
        reason: options.reason ?? this.status.reason,
        message: options.message ?? this.status.message,
        terminalReason: reason,
        retry: undefined,
        turn: finished,
        lastEventAt: now,
      };
    } else {
      this.status = {
        ...this.status,
        state: options.state ?? this.status.state,
        phase,
        reason: options.reason ?? this.status.reason,
        message: options.message ?? this.status.message,
        terminalReason: reason,
        lastEventAt: now,
      };
    }
    this.record(`terminal:${reason}`, traceDetail(options.message) ?? options.reason);
  }
}
