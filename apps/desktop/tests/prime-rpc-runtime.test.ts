import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimeRpc, projectRuntimeJournal } from "../electron/main/prime-rpc";
import type { RuntimeTraceEntry } from "../electron/main/runtime-state";
import type { RuntimeBridge } from "../electron/main/runtime-bridge";
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

  it("settles a reasoning_limit turn from the full Prime event sequence", async () => {
    vi.useFakeTimers();
    const { runtime, send } = harness({ failureGraceMs: 40 });
    const limited = { role: "assistant", content: [{ type: "thinking", thinking: "cut" }], stopReason: "reasoning_limit" };
    await runtime.prompt("start");
    send({ type: "agent_start" });
    send({ type: "message_start", message: { role: "assistant" } });
    send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "..." } });
    send({ type: "message_end", message: limited });
    expect(runtime.status).toMatchObject({ phase: "reasoning_limit", terminalReason: undefined });

    send({ type: "agent_end", messages: [limited] });
    // The turn must not be settled as completed on the way through agent_end.
    expect(runtime.status.terminalReason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.status).toMatchObject({ state: "ready", phase: "reasoning_limit", terminalReason: "reasoning_limit", reason: "reasoning_limit" });
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

  it("keeps the stall watchdog on provider events, not on runtime chatter", async () => {
    vi.useFakeTimers();
    const { runtime, send } = harness({ providerTimeoutMs: 200 });
    await runtime.prompt("start");
    send({ type: "agent_start" });

    // Prime keeps reporting agent_status while the model itself is silent; the
    // renderer must still be told the provider stopped answering.
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(60);
      send({ type: "agent_status", taskState: "running", summary: "still up" });
    }
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "stalled", reason: "provider_silent", terminalReason: undefined });

    // A real stream event resumes the turn and restarts the watchdog.
    send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "back" } });
    expect(runtime.status.phase).toBe("thinking");
    await vi.advanceTimersByTimeAsync(230);
    expect(runtime.status).toMatchObject({ phase: "stalled", reason: "provider_silent" });
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

  it("writes the runtime journal while a turn moves", async () => {
    const { runtime, send } = harness();
    const lines: RuntimeTraceEntry[] = [];
    (runtime as any).journal = async (entries: RuntimeTraceEntry[]) => { lines.push(...entries); };

    await runtime.prompt("start");
    send({ type: "agent_start" });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000, errorMessage: "529 overloaded_error: Overloaded" });
    send({ type: "auto_retry_end", success: true, attempt: 1 });
    send({ type: "agent_end", messages: [] });

    expect(lines.map((line) => line.event)).toEqual([
      "turn_started",
      "phase:waiting_provider",
      "phase:retrying",
      "phase:provider_wait",
      "terminal:completed",
    ]);
    expect(lines.every((line) => line.turnId === "turn-1")).toBe(true);
  });
});

describe("runtime journal file", () => {
  function bridge(calls: Array<{ args: string[]; input: string }>): Pick<RuntimeBridge, "pipe"> {
    return {
      pipe: async (args: string[], input: string) => {
        calls.push({ args, input });
        return { stdout: "", stderr: "" };
      },
    } as Pick<RuntimeBridge, "pipe">;
  }

  it("appends journal entries as JSON lines beside the project", async () => {
    const calls: Array<{ args: string[]; input: string }> = [];
    const journal = projectRuntimeJournal(bridge(calls), "/home/eng/demo/");
    expect(journal).toBeDefined();
    await journal!([
      { at: "2026-09-17T20:00:00.000+08:00", phase: "retrying", event: "phase:retrying", turnId: "turn-1", detail: "attempt 1 of 3" },
      { at: "2026-09-17T20:00:02.000+08:00", phase: "provider_wait", event: "phase:provider_wait", turnId: "turn-1" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[2]).toContain("/home/eng/demo/.pi-cad/desktop-runtime.jsonl");
    const written = calls[0]!.input.trim().split("\n").map((line) => JSON.parse(line));
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ event: "phase:retrying", phase: "retrying", turnId: "turn-1", detail: "attempt 1 of 3" });
    expect(calls[0]!.input.endsWith("\n")).toBe(true);
  });

  it("skips the journal when the project folder is unknown", async () => {
    const calls: Array<{ args: string[]; input: string }> = [];
    expect(projectRuntimeJournal(bridge(calls), "")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
