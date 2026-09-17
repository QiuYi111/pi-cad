import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimeRpc } from "../electron/main/prime-rpc";
import type { RuntimeStatus } from "../src/shared/contracts";

/** Minimal stand-in for the Prime sidecar process. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: vi.fn(), end: vi.fn() };
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit("exit", null, "SIGKILL")); return true; });
  return child as EventEmitter & { stdout: EventEmitter; stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> };
}

function harness(options: Record<string, unknown> = {}) {
  const runtime = new PrimeRpc({} as never, { providerTimeoutMs: 0, abortTimeoutMs: 1_000, abortRpcTimeoutMs: 500, failureGraceMs: 50, ...options } as any);
  const child = fakeChild();
  (runtime as any).child = child;
  const request = vi.spyOn(runtime, "request").mockResolvedValue(undefined);
  const statuses: RuntimeStatus[] = [];
  runtime.on("status", (status: RuntimeStatus) => statuses.push(status));
  const send = (record: unknown) => (runtime as any).consume(`${JSON.stringify(record)}\n`);
  return { runtime, child, request, statuses, send };
}

afterEach(() => { vi.useRealTimers(); });

describe("PrimeRpc runtime state", () => {
  it("publishes retry, provider wait and terminal phases from Prime events", async () => {
    const { runtime, request, statuses, send } = harness();
    await runtime.prompt("start");
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "starting_turn" });

    send({ type: "agent_start" });
    expect(runtime.status).toMatchObject({ phase: "waiting_provider", turn: { retryAttempt: 0 } });

    send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" } });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000, errorMessage: "529 overloaded_error: Overloaded" });
    expect(runtime.status).toMatchObject({ phase: "retrying", retry: { attempt: 1, maxAttempts: 3, delayMs: 1_000, reason: "provider_unavailable" } });

    send({ type: "auto_retry_end", success: true, attempt: 1 });
    expect(runtime.status).toMatchObject({ phase: "provider_wait", reason: "retry_succeeded" });

    send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    expect(runtime.status.phase).toBe("responding");
    send({ type: "agent_end", messages: [] });
    expect(runtime.status).toMatchObject({ state: "ready", phase: "ready", terminalReason: "completed" });

    expect(request.mock.calls.map(([type]) => type)).toEqual(["prompt"]);
    expect(statuses.at(-1)).toBe(runtime.status);
    expect(statuses.some((status) => status.phase === "retrying")).toBe(true);
    expect(statuses.some((status) => status.phase === "provider_wait")).toBe(true);
  });

  it("moves a retry delay into the retry attempt wait", async () => {
    vi.useFakeTimers();
    const { runtime, send } = harness();
    await runtime.prompt("start");
    send({ type: "agent_start" });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 400, errorMessage: "overloaded_error" });
    expect(runtime.status.phase).toBe("retrying");
    await vi.advanceTimersByTimeAsync(430);
    expect(runtime.status).toMatchObject({ phase: "provider_wait", reason: "retry_attempt" });
  });

  it("settles an error into a terminal reason when no retry follows", async () => {
    vi.useFakeTimers();
    const { runtime, send } = harness({ failureGraceMs: 40 });
    await runtime.prompt("start");
    send({ type: "agent_start" });
    send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out" } });
    expect(runtime.status).toMatchObject({ phase: "provider_timeout", terminalReason: undefined });
    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.status).toMatchObject({ state: "ready", phase: "provider_timeout", terminalReason: "provider_timeout" });
  });

  it("marks a silent provider as stalled instead of a terminal timeout", async () => {
    vi.useFakeTimers();
    const { runtime, send } = harness({ providerTimeoutMs: 200 });
    await runtime.prompt("start");
    send({ type: "agent_start" });
    await vi.advanceTimersByTimeAsync(230);
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "stalled", reason: "provider_silent", terminalReason: undefined });
    expect(runtime.status.turn?.terminalReason).toBeUndefined();

    send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "back" } });
    expect(runtime.status).toMatchObject({ phase: "thinking", terminalReason: undefined });
  });

  it("classifies a streaming error from the event body", async () => {
    const { runtime, send } = harness();
    await runtime.prompt("start");
    send({ type: "agent_start" });
    send({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "reasoning budget exhausted" } } });
    expect(runtime.status).toMatchObject({ phase: "reasoning_limit", reason: "reasoning_limit", terminalReason: undefined });
  });

  it("completes the abort handshake on message_end(aborted)", async () => {
    const { runtime, request, send } = harness();
    await runtime.prompt("start");
    send({ type: "agent_start" });
    send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "working" } });

    const aborted = runtime.abort();
    await Promise.resolve();
    expect(runtime.status).toMatchObject({ state: "stopping", phase: "stopping" });
    expect(request).toHaveBeenCalledWith("abort", {}, 500);

    send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
    await aborted;
    expect(runtime.status).toMatchObject({ state: "ready", phase: "aborted", terminalReason: "aborted" });
    expect(runtime.status.turn?.terminalReason).toBe("aborted");
  });

  it("forces the sidecar down when the stop handshake misses its deadline", async () => {
    vi.useFakeTimers();
    const { runtime, child, send } = harness({ abortTimeoutMs: 300 });
    await runtime.prompt("start");
    send({ type: "agent_start" });
    const aborted = runtime.abort();
    await vi.advanceTimersByTimeAsync(320);
    await vi.advanceTimersByTimeAsync(1_600);
    await aborted;
    expect(child.kill).toHaveBeenCalled();
    expect(runtime.status).toMatchObject({ state: "error", terminalReason: "forced_stop", reason: "stop_timeout" });
  });

  it("has nothing to stop when no turn is running", async () => {
    const { runtime, request } = harness();
    await runtime.abort();
    expect(request).not.toHaveBeenCalled();
  });
});
