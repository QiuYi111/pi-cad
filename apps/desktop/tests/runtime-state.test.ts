import { describe, expect, it } from "vitest";
import { classifyProviderFailure, PrimeRuntimeState, reasoningLimitEvidence } from "../electron/main/runtime-state";

function state(failureGraceMs = 0) {
  const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { failureGraceMs });
  return runtime;
}

describe("Prime runtime phases", () => {
  it("distinguishes the initial provider wait, thinking and responding", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "starting_turn" });

    runtime.applyEvent({ type: "agent_start" });
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "waiting_provider" });

    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "..." } });
    expect(runtime.status.phase).toBe("thinking");

    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    expect(runtime.status.phase).toBe("responding");

    runtime.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "ipython" });
    expect(runtime.status.phase).toBe("running_tool");

    runtime.applyEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "ipython" });
    expect(runtime.status.phase).toBe("waiting_provider");
  });

  it("tracks turn timestamps and retry attempts", () => {
    const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { now: () => 1_000 });
    runtime.beginTurn("prompt", "turn-1");
    expect(runtime.status.turn).toMatchObject({ id: "turn-1", startedAt: 1_000, phaseStartedAt: 1_000, lastEventAt: 1_000, retryAttempt: 0, phase: "starting_turn" });
    runtime.applyEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4_000, errorMessage: "overloaded_error" });
    expect(runtime.status).toMatchObject({
      phase: "retrying",
      reason: "provider_unavailable",
      retry: { attempt: 2, maxAttempts: 3, delayMs: 4_000, reason: "provider_unavailable" },
      turn: { retryAttempt: 2 },
    });
    runtime.retryDelayElapsed(2);
    expect(runtime.status).toMatchObject({ phase: "provider_wait", reason: "retry_attempt", retry: { attempt: 2 } });
  });

  it("keeps the phase clock across same-phase stream deltas", () => {
    let clock = 1_000;
    const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { now: () => clock });
    runtime.beginTurn("prompt");

    clock = 1_500;
    runtime.applyEvent({ type: "agent_start" });
    expect(runtime.status.turn).toMatchObject({ phase: "waiting_provider", phaseStartedAt: 1_500, lastEventAt: 1_500 });

    clock = 1_800;
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
    expect(runtime.status.turn).toMatchObject({ phase: "thinking", phaseStartedAt: 1_800, lastEventAt: 1_800 });

    // Two more thinking tokens must not restart the phase the user is watching.
    clock = 2_400;
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "b" } });
    clock = 3_000;
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "c" } });
    expect(runtime.status.turn).toMatchObject({ phase: "thinking", phaseStartedAt: 1_800, lastEventAt: 3_000 });

    // A real phase move still starts a new clock.
    clock = 3_600;
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    expect(runtime.status.turn).toMatchObject({ phase: "responding", phaseStartedAt: 3_600, lastEventAt: 3_600 });

    clock = 4_200;
    runtime.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "ipython" });
    clock = 4_800;
    runtime.applyEvent({ type: "tool_execution_update", toolCallId: "t1", toolName: "ipython", stage: "progress" });
    expect(runtime.status.turn).toMatchObject({ phase: "running_tool", phaseStartedAt: 4_200, lastEventAt: 4_800 });
  });

  it("holds a provider error through the retry grace and keeps retrying visible", () => {
    const runtime = state(1_500);
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" } });
    // Provisional failure: the turn is not terminal while a retry may follow.
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "failed", reason: "provider_unavailable" });
    expect(runtime.status.terminalReason).toBeUndefined();
    expect(runtime.failurePending).toBe(true);

    runtime.applyEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "529 overloaded_error: Overloaded" });
    expect(runtime.failurePending).toBe(false);
    expect(runtime.status).toMatchObject({ phase: "retrying", retry: { attempt: 1, maxAttempts: 3, delayMs: 2_000, reason: "provider_unavailable" } });
    expect(runtime.status.terminalReason).toBeUndefined();

    runtime.applyEvent({ type: "auto_retry_end", success: true, attempt: 1 });
    expect(runtime.status).toMatchObject({ phase: "provider_wait", reason: "retry_succeeded" });
    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
    runtime.applyEvent({ type: "agent_end", messages: [] });
    expect(runtime.status).toMatchObject({ state: "ready", phase: "ready", terminalReason: "completed" });
  });

  it("settles an unrecovered provider error into a terminal reason", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out after 120s" } });
    expect(runtime.status).toMatchObject({ phase: "provider_timeout", terminalReason: undefined });
    runtime.settleFailure();
    expect(runtime.status).toMatchObject({ state: "ready", phase: "provider_timeout", terminalReason: "provider_timeout", reason: "provider_timeout" });
  });

  it("takes a streaming error from assistantMessageEvent.error, not the partial message", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "reasoning budget exhausted" } },
    });
    expect(runtime.status).toMatchObject({ phase: "reasoning_limit", reason: "reasoning_limit", terminalReason: undefined });
    runtime.settleFailure();
    expect(runtime.status).toMatchObject({ terminalReason: "reasoning_limit", reason: "reasoning_limit" });

    const aborted = state();
    aborted.beginTurn("prompt");
    aborted.applyEvent({ type: "agent_start" });
    aborted.applyEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted" } },
    });
    expect(aborted.status).toMatchObject({ phase: "aborted", terminalReason: "aborted" });
  });

  it("only calls a length stop a reasoning limit when the thinking budget is the evidence", () => {
    const truncated = state();
    truncated.beginTurn("prompt");
    truncated.applyEvent({ type: "agent_start" });
    truncated.applyEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "length" }] });
    expect(truncated.status).toMatchObject({ state: "ready", phase: "ready", terminalReason: "completed", reason: "output_limit" });

    const thinking = state();
    thinking.beginTurn("prompt");
    thinking.applyEvent({ type: "agent_start" });
    thinking.applyEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "still reasoning" }], stopReason: "length" } });
    expect(thinking.status).toMatchObject({ phase: "reasoning_limit", terminalReason: undefined });
    thinking.settleFailure();
    expect(thinking.status).toMatchObject({ terminalReason: "reasoning_limit", reason: "thinking_truncated" });

    const named = state();
    named.beginTurn("prompt");
    named.applyEvent({ type: "agent_start" });
    named.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "length", errorMessage: "thinking budget exceeded" } });
    named.settleFailure();
    expect(named.status).toMatchObject({ terminalReason: "reasoning_limit", reason: "reasoning_budget" });
  });

  it("recognises a reasoning_limit stop reason without flipping through completed", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "..." } });
    runtime.applyEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "cut" }], stopReason: "reasoning_limit" },
    });
    expect(runtime.status).toMatchObject({ phase: "reasoning_limit", reason: "reasoning_limit", terminalReason: undefined });
    expect(runtime.failurePending).toBe(true);

    // agent_end repeats the same message: it must stay a pending failure instead
    // of being settled as a completed turn first.
    runtime.applyEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "cut" }], stopReason: "reasoning_limit" }],
    });
    expect(runtime.status.terminalReason).toBeUndefined();
    expect(runtime.status.turn?.terminalReason).toBeUndefined();

    runtime.settleFailure();
    expect(runtime.status).toMatchObject({ state: "ready", phase: "reasoning_limit", terminalReason: "reasoning_limit", reason: "reasoning_limit" });
    expect(runtime.status.turn?.terminalReason).toBe("reasoning_limit");
  });

  it("takes a reasoning_limit streaming error from the event body", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "reasoning_limit" } },
    });
    expect(runtime.status).toMatchObject({ phase: "reasoning_limit", reason: "reasoning_limit", terminalReason: undefined });
    runtime.settleFailure();
    expect(runtime.status).toMatchObject({ terminalReason: "reasoning_limit", reason: "reasoning_limit" });
  });

  it("reads the legacy reasoning-limit hint from Prime's raw stop reason", () => {
    // Prime calls the field `stopReasonRaw`; any other name reads `undefined`
    // and silently disables the legacy `stopReason === "length"` fallback.
    expect(reasoningLimitEvidence({ stopReason: "length", stopReasonRaw: "reasoning budget exceeded" })).toBe("reasoning_budget");
    expect(reasoningLimitEvidence({ stopReason: "length", rawStopReason: "reasoning budget exceeded" })).toBeUndefined();

    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "length", stopReasonRaw: "thinking budget exceeded" },
    });
    expect(runtime.status).toMatchObject({ phase: "reasoning_limit", reason: "reasoning_budget", terminalReason: undefined });
    runtime.settleFailure();
    expect(runtime.status).toMatchObject({ terminalReason: "reasoning_limit", reason: "reasoning_budget" });
  });

  it("keeps exhausted retries terminal even when a late agent_end arrives", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded_error: Overloaded" });
    runtime.settleFailure();
    expect(runtime.status).toMatchObject({ state: "ready", phase: "failed", terminalReason: "provider_error", reason: "provider_unavailable" });

    runtime.applyEvent({ type: "agent_end", messages: [] });
    runtime.applyEvent({ type: "agent_status", taskState: "needs_input", summary: "" });
    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop" } });
    expect(runtime.status).toMatchObject({ terminalReason: "provider_error", phase: "failed" });
    expect(runtime.status.turn?.terminalReason).toBe("provider_error");

    runtime.beginTurn("prompt", "next");
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "starting_turn", terminalReason: undefined });
  });

  it("reports a stalled provider without ending the turn", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.providerStall(600_000);
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "stalled", reason: "provider_silent", terminalReason: undefined });
    expect(runtime.activeTurn()).toBeDefined();
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "..." } });
    expect(runtime.status.phase).toBe("thinking");
    expect(runtime.status.reason).toBe("reasoning");
  });

  it("keeps provider activity separate from ordinary runtime events", () => {
    let clock = 1_000;
    const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { now: () => clock });
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    expect(runtime.lastProviderEventAt).toBe(1_000);

    clock = 2_000;
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: ".." } });
    expect(runtime.lastProviderEventAt).toBe(2_000);

    // Runtime chatter keeps `lastEventAt` fresh but must not hide a silent model.
    clock = 3_000;
    runtime.applyEvent({ type: "agent_status", taskState: "running", summary: "still up" });
    runtime.applyEvent({ type: "session_action_update", action: "queued" });
    expect(runtime.status.lastEventAt).toBe(3_000);
    expect(runtime.lastProviderEventAt).toBe(2_000);
    expect(runtime.status.turn?.lastProviderEventAt).toBe(2_000);

    clock = 3_500;
    runtime.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "ipython" });
    clock = 4_000;
    runtime.applyEvent({ type: "tool_execution_update", toolCallId: "t1", toolName: "ipython", stage: "progress" });
    expect(runtime.lastProviderEventAt).toBe(2_000);

    // The tool result opens a new provider request, so the clock restarts.
    clock = 4_500;
    runtime.applyEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "ipython" });
    expect(runtime.status.phase).toBe("waiting_provider");
    expect(runtime.lastProviderEventAt).toBe(4_500);
  });

  it("restarts the provider clock when agent_start arrives", () => {
    let clock = 1_000;
    const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { now: () => clock });
    runtime.beginTurn("prompt");
    expect(runtime.lastProviderEventAt).toBe(1_000);

    // The prompt waited in `starting_turn` while Prime booted. `agent_start` is
    // the provider picking the request up, so the stall clock restarts here
    // instead of staying on the prompt.
    clock = 1_900;
    runtime.applyEvent({ type: "agent_start" });
    expect(runtime.lastProviderEventAt).toBe(1_900);
    expect(runtime.status.lastProviderEventAt).toBe(1_900);
    expect(runtime.status.turn?.lastProviderEventAt).toBe(1_900);
  });

  it("records the retry and failure deadlines instead of restarting them", () => {
    let clock = 1_000;
    const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { now: () => clock, failureGraceMs: 1_500 });
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "overloaded_error" });
    expect(runtime.retryDeadline).toBe(3_000);

    // Runtime chatter must not push the backoff back.
    clock = 2_500;
    runtime.applyEvent({ type: "agent_status", taskState: "running", summary: "still up" });
    runtime.applyEvent({ type: "session_action_update", action: "queued" });
    expect(runtime.retryDeadline).toBe(3_000);

    runtime.retryDelayElapsed(1);
    expect(runtime.retryDeadline).toBeUndefined();

    // The same rule holds for the grace that precedes a terminal failure.
    clock = 4_000;
    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out" } });
    expect(runtime.failureDeadline).toBe(5_500);
    clock = 4_600;
    runtime.applyEvent({ type: "agent_status", taskState: "running", summary: "still up" });
    expect(runtime.failureDeadline).toBe(5_500);

    runtime.settleFailure();
    expect(runtime.failureDeadline).toBeUndefined();
  });

  it("keeps the last completed turn when the runtime stops normally", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "agent_end", messages: [] });
    expect(runtime.status).toMatchObject({ state: "ready", phase: "ready", terminalReason: "completed" });

    runtime.processExited(0, null);
    expect(runtime.status).toMatchObject({ state: "idle", phase: "ready", terminalReason: "completed" });
    expect(runtime.status.turn?.terminalReason).toBe("completed");

    const aborted = state();
    aborted.beginTurn("prompt");
    aborted.applyEvent({ type: "agent_start" });
    aborted.applyEvent({ type: "agent_abort" });
    aborted.processExited(0, null);
    expect(aborted.status).toMatchObject({ state: "idle", phase: "aborted", terminalReason: "aborted" });
    expect(aborted.status.turn?.terminalReason).toBe("aborted");
  });

  it("moves the process state for every settled turn without rewriting the turn", () => {
    const limited = state();
    limited.beginTurn("prompt");
    limited.applyEvent({ type: "agent_start" });
    limited.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "reasoning_limit" } });
    limited.settleFailure();
    expect(limited.status).toMatchObject({ state: "ready", terminalReason: "reasoning_limit" });

    limited.processExited(0, null);
    expect(limited.status).toMatchObject({ state: "idle", phase: "reasoning_limit", terminalReason: "reasoning_limit" });
    expect(limited.status.turn?.terminalReason).toBe("reasoning_limit");

    // A crash after a failure is a process error, not a new turn outcome.
    const crashed = state();
    crashed.beginTurn("prompt");
    crashed.applyEvent({ type: "agent_start" });
    crashed.applyEvent({ type: "agent_abort" });
    crashed.processExited(9, null);
    expect(crashed.status).toMatchObject({ state: "error", phase: "aborted", terminalReason: "aborted" });
    expect(crashed.status.turn?.terminalReason).toBe("aborted");
    expect(crashed.status.message).toBe("Prime exited (9)");
  });

  it("separates RPC timeouts from provider timeouts", () => {
    const never = state();
    never.beginTurn("prompt");
    never.rpcFailure("rpc_timeout", "Prime RPC prompt timed out");
    expect(never.status).toMatchObject({ state: "ready", phase: "rpc_timeout", terminalReason: "rpc_timeout", reason: "rpc_timeout" });

    const running = state();
    running.beginTurn("prompt");
    running.applyEvent({ type: "agent_start" });
    running.rpcFailure("rpc_timeout", "Prime RPC prompt timed out");
    // Prime may still be working: record the transport timeout without ending the turn.
    expect(running.status).toMatchObject({ state: "streaming", phase: "rpc_timeout", reason: "rpc_timeout", terminalReason: undefined });
    expect(running.activeTurn()).toBeDefined();
  });

  it("confirms a user abort from message_end(aborted) and ignores stale events", () => {
    const runtime = state(1_500);
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "half" } });
    runtime.beginStopping();
    expect(runtime.status).toMatchObject({ state: "stopping", phase: "stopping" });

    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
    expect(runtime.status).toMatchObject({ state: "ready", phase: "aborted", terminalReason: "aborted", reason: "user_abort" });
    expect(runtime.activeTurn()).toBeUndefined();

    runtime.applyEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    runtime.applyEvent({ type: "agent_status", taskState: "needs_input" });
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "late" } });
    expect(runtime.status).toMatchObject({ phase: "aborted", terminalReason: "aborted" });
  });

  it("escalates to a forced stop when the sidecar dies mid-stop", () => {
    const runtime = state();
    runtime.beginTurn("prompt");
    runtime.applyEvent({ type: "agent_start" });
    runtime.beginStopping();
    runtime.processExited(null, "SIGKILL", true);
    expect(runtime.status).toMatchObject({ state: "error", terminalReason: "forced_stop", reason: "stop_timeout" });
    runtime.processExited(0, null, false);
    expect(runtime.status.terminalReason).toBe("forced_stop");

    const crashed = state();
    crashed.beginTurn("prompt");
    crashed.applyEvent({ type: "agent_start" });
    crashed.processExited(1, null);
    expect(crashed.status).toMatchObject({ state: "error", phase: "failed", terminalReason: "process_exit" });
  });
});

describe("runtime journal", () => {
  it("records the turn, every phase move and the terminal reason in order", () => {
    const runtime = new PrimeRuntimeState({ state: "ready", checks: [] }, { now: () => 1_000 });
    runtime.beginTurn("prompt", "turn-1");
    runtime.applyEvent({ type: "agent_start" });
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: ".." } });
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: ".." } });
    runtime.applyEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "529 overloaded_error: Overloaded" });
    runtime.applyEvent({ type: "auto_retry_end", success: true, attempt: 1 });
    runtime.applyEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    runtime.applyEvent({ type: "agent_end", messages: [] });

    const entries = runtime.drain();
    // Repeated stream deltas stay inside one phase: only real moves are journaled.
    expect(entries.map((entry) => entry.event)).toEqual([
      "turn_started",
      "phase:waiting_provider",
      "phase:thinking",
      "phase:retrying",
      "phase:provider_wait",
      "phase:responding",
      "terminal:completed",
    ]);
    expect(entries.every((entry) => entry.turnId === "turn-1")).toBe(true);
    expect(entries.every((entry) => /T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(entry.at))).toBe(true);
    expect(entries.at(-1)).toMatchObject({ phase: "ready", detail: "turn_complete" });
    expect(entries[3]).toMatchObject({ phase: "retrying", detail: "provider_unavailable" });
    expect(runtime.drain()).toEqual([]);
  });

  it("keeps one terminal line when stale events arrive after an abort", () => {
    const runtime = state();
    runtime.beginTurn("prompt", "turn-1");
    runtime.applyEvent({ type: "agent_start" });
    runtime.beginStopping();
    runtime.applyEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
    runtime.applyEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    runtime.applyEvent({ type: "agent_status", taskState: "needs_input", summary: "" });

    expect(runtime.drain().map((entry) => entry.event)).toEqual([
      "turn_started",
      "phase:waiting_provider",
      "phase:stopping",
      "terminal:aborted",
    ]);
  });
});

describe("provider failure classification", () => {
  it.each([
    ["Request timed out", "provider_timeout"],
    ["429 rate limit exceeded", "provider_error"],
    ["Provided authentication token is expired.", "provider_error"],
    ["connection reset by peer", "provider_error"],
    ["529 overloaded_error: Overloaded", "provider_error"],
    ["reasoning budget exhausted", "reasoning_limit"],
    ["Retry cancelled", "aborted"],
  ])("maps %s to %s", (message, terminalReason) => {
    expect(classifyProviderFailure(message).terminalReason).toBe(terminalReason);
  });
});
