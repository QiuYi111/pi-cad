import { describe, expect, it, vi } from "vitest";
import {
  awaitAbortConfirmation,
  PrimeRuntimeState,
  runtimeStateSettled,
} from "../electron/main/runtime-state";

const thinking = { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" } };
const answering = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } };
const transientFailure = {
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" },
};
const success = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };

function phasesOf(state: PrimeRuntimeState, events: any[], at = 1_700_000_000_000): string[] {
  const phases = [state.state];
  for (const [index, event] of events.entries()) {
    state.apply(event, at + index * 10);
    if (phases.at(-1) !== state.state) phases.push(state.state);
  }
  return phases;
}

describe("Prime runtime state machine", () => {
  it("keeps the thinking → retry → thinking → success order", () => {
    const state = new PrimeRuntimeState("ready");
    const phases = phasesOf(state, [
      { type: "agent_start" },
      thinking,
      transientFailure,
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "529 overloaded_error" },
      { type: "auto_retry_end", success: true, attempt: 2 },
      thinking,
      answering,
      success,
      { type: "agent_end", messages: [] },
    ]);

    expect(phases).toEqual(["ready", "waiting_provider", "running", "retrying", "waiting_provider", "running", "ready"]);
    expect(state.state).toBe("ready");
    const turn = state.turn!;
    expect(turn.retryAttempts).toBe(1);
    expect(turn.retry).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 2_000, reason: "529 overloaded_error" });
    expect(turn.terminalReason).toBe("completed");
    expect(turn.firstProviderEventAt).toBeDefined();
    expect(turn.endedAt).toBeDefined();
  });

  it("surfaces a reasoning limit as the terminal reason", () => {
    const state = new PrimeRuntimeState("ready");
    state.apply({ type: "agent_start" }, 1);
    state.apply(thinking, 2);
    state.apply({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Reasoning budget exceeded before the model answered.",
        diagnostics: [{ type: "provider_stream_failure", details: { kind: "reasoning_limit" } }],
      },
    }, 3);
    state.apply({ type: "agent_end", messages: [] }, 4);

    expect(state.state).toBe("failed");
    expect(state.turn?.terminalReason).toBe("reasoning_limit");
    expect(state.status().message).toMatch(/reasoning limit/i);
    expect(runtimeStateSettled(state.state)).toBe(true);
  });

  it("distinguishes a provider timeout from an ordinary provider failure", () => {
    const timeout = new PrimeRuntimeState("ready");
    timeout.apply({ type: "agent_start" }, 1);
    timeout.apply({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Request timed out after 600s" } }, 2);
    timeout.apply({ type: "agent_end", messages: [] }, 3);
    expect(timeout.turn?.terminalReason).toBe("provider_timeout");

    const failure = new PrimeRuntimeState("ready");
    failure.apply({ type: "agent_start" }, 1);
    failure.apply({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401 unauthorized" } }, 2);
    failure.apply({ type: "agent_end", messages: [] }, 3);
    expect(failure.turn?.terminalReason).toBe("provider_error");
  });

  it("keeps the stop unconfirmed until Prime really aborts", () => {
    const state = new PrimeRuntimeState("ready");
    state.apply({ type: "agent_start" }, 1);
    state.apply(thinking, 2);
    expect(state.requestAbort(3)).toBe(true);
    expect(state.state).toBe("stopping");

    // The RPC acknowledgement, the empty needs_input verdict, and an unrelated
    // status update are all NOT stop confirmations.
    state.apply({ type: "agent_status", status: { summary: " ", taskState: "needs_input" } }, 4);
    expect(state.state).toBe("stopping");
    expect(state.turn?.abortConfirmedAt).toBeUndefined();

    state.apply({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } }, 5);
    expect(state.state).toBe("stopping");
    expect(state.turn?.abortConfirmedAt).toBeDefined();

    state.apply({ type: "agent_end", messages: [] }, 6);
    expect(state.state).toBe("aborted");
    expect(state.turn?.terminalReason).toBe("aborted");
    expect(state.turn?.abortRequestedAt).toBeDefined();
  });

  it("never turns an empty needs_input verdict into a runtime state", () => {
    const state = new PrimeRuntimeState("ready");
    state.apply({ type: "agent_start" }, 1);
    expect(state.apply({ type: "agent_status", status: { summary: "", taskState: "needs_input" } }, 2)).toBe(false);
    expect(state.state).toBe("waiting_provider");
    const entries = state.drain();
    expect(entries.map((entry) => entry.event)).toContain("agent_status_ignored");
  });

  it("settles a rejected prompt instead of waiting for an agent_end", () => {
    const state = new PrimeRuntimeState("ready");
    state.expectTurn(1, "prompt");
    expect(state.state).toBe("waiting_provider");
    state.apply({ type: "agent_error", message: "Prime is not running" }, 2);
    expect(state.state).toBe("failed");
    expect(state.turn?.terminalReason).toBe("provider_error");
  });

  it("ignores a stale abort so the runtime is not parked in stopping", () => {
    const state = new PrimeRuntimeState("ready");
    expect(state.busy).toBe(false);
    expect(state.apply({ type: "agent_abort" }, 1)).toBe(false);
    expect(state.state).toBe("ready");

    state.expectTurn(2, "prompt");
    expect(state.busy).toBe(true);
    state.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }, 3);
    state.apply({ type: "agent_end", messages: [] }, 4);
    expect(state.apply({ type: "agent_abort" }, 5)).toBe(false);
    expect(state.state).toBe("ready");
  });

  it("journals every state change with an offset timestamp", () => {
    const state = new PrimeRuntimeState("ready");
    state.apply({ type: "agent_start" }, 1_700_000_000_000);
    state.apply({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: "rate limited" }, 1_700_000_001_000);
    const entries = state.drain();
    expect(entries.map((entry) => entry.event)).toEqual(["turn_started", "agent_start", "auto_retry_start"]);
    for (const entry of entries) {
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    }
    expect(entries.at(-1)?.detail).toContain("attempt 2 of 3 in 500ms");
    expect(state.drain()).toEqual([]);
  });
});

describe("stop confirmation", () => {
  it("does not escalate when the runtime confirms the stop", async () => {
    const requestAbort = vi.fn().mockResolvedValue(undefined);
    const escalate = vi.fn().mockResolvedValue(undefined);
    await expect(awaitAbortConfirmation({
      requestAbort,
      escalate,
      waitForSettle: async () => true,
      timeoutMs: 10,
    })).resolves.toBe("confirmed");
    expect(requestAbort).toHaveBeenCalledOnce();
    expect(escalate).not.toHaveBeenCalled();
  });

  it("escalates to a process stop when the stop stays unconfirmed", async () => {
    const requestAbort = vi.fn().mockResolvedValue(undefined);
    const escalate = vi.fn().mockResolvedValue(undefined);
    await expect(awaitAbortConfirmation({
      requestAbort,
      escalate,
      waitForSettle: async () => false,
      timeoutMs: 10,
    })).resolves.toBe("escalated");
    expect(requestAbort).toHaveBeenCalledOnce();
    expect(escalate).toHaveBeenCalledOnce();
  });
});
