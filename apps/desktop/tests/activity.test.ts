import { describe, expect, it } from "vitest";
import { reducePrimeEvent } from "../src/renderer/src/lib/activity";

describe("Prime activity projection", () => {
  it("shows thinking immediately and streams into one message", () => {
    let messages = reducePrimeEvent([], { type: "agent_start" });
    expect(messages[0]?.stream?.state).toBe("waiting");
    messages = reducePrimeEvent(messages, { type: "message_update", message: { id: "a1", role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } });
    expect(messages[0]).toMatchObject({ text: "", stream: { state: "thinking" } });
    messages = reducePrimeEvent(messages, { type: "message_update", message: { id: "a1", role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
    messages = reducePrimeEvent(messages, { type: "message_update", message: { id: "a1", role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: " world" } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "Hello world", stream: { state: "responding" } });
    messages = reducePrimeEvent(messages, { type: "message_end", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Hello world" }] } });
    expect(messages[0]).toMatchObject({ id: "a1", text: "Hello world", stream: { state: "complete" } });
  });

  it("keeps event order when stream updates are frame-batched", () => {
    const messages = reducePrimeEvent([], { type: "desktop_event_batch", events: [
      { type: "agent_start" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } },
      { type: "agent_end" },
    ] });
    expect(messages[0]).toMatchObject({ text: "Done", stream: { state: "complete" } });
  });

  it("replaces the visible conversation when a saved session is selected", () => {
    const messages = reducePrimeEvent([{ id: "old", role: "user", text: "old", createdAt: 1 }], {
      type: "desktop_session_loaded",
      messages: [
        { id: "u1", role: "user", content: "build a bracket", timestamp: 2 },
        { id: "a1", role: "assistant", content: [{ type: "text", text: "Starting now" }], timestamp: 3 },
      ],
    });
    expect(messages.map((message) => message.text)).toEqual(["build a bracket", "Starting now"]);
  });

  it("shows provider failures instead of completing an empty assistant row", () => {
    let messages = reducePrimeEvent([], { type: "agent_start" });
    messages = reducePrimeEvent(messages, {
      type: "message_end",
      message: {
        id: "expired",
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provided authentication token is expired.",
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "expired",
      text: "Provided authentication token is expired.",
      stream: { state: "error" },
    });
  });
  it("turns a CAD build call into one completed semantic card", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "b1", toolName: "ipython", args: { code: "await cad.model.build(source, output)" } });
    expect(messages[0]?.activity).toMatchObject({ kind: "build", state: "running" });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "b1", result: { content: [{ type: "text", text: "built /workspace/bracket.step" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=", role: "isometric" }] } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.activity).toMatchObject({ state: "success", title: "Model built" });
    expect(messages[0]?.activity?.media?.[0]?.dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(messages[0]?.activity?.artifactPath).toBe("/workspace/bracket.step");
    expect(messages[0]?.activity?.details).toBeUndefined();
  });

  it("treats save_and_check as the same managed build activity", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "macro", toolName: "ipython", args: { code: "result = await cad.save_and_check('quick-build', source, output)" } });
    expect(messages[0]?.activity).toMatchObject({ kind: "build", state: "running" });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "macro", result: { content: [{ type: "text", text: "SaveAndCheckResult(commit='c1', artifact='build/bracket.step')" }] } });
    expect(messages[0]?.activity).toMatchObject({ kind: "build", state: "success", artifactPath: "build/bracket.step" });
  });

  it("deduplicates a build image exposed through content and attachment details", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "b2", toolName: "ipython", args: { code: "await cad.model.build(source, output)" } });
    const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=", name: "iso" };
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "b2", result: { details: { attachments: [image] }, content: [{ type: "text", text: "built" }, image] } });
    expect(messages[0]?.activity?.media).toHaveLength(1);
    expect(messages[0]?.activity?.media?.[0]?.label).toBe("iso");
  });

  it("shows ordinary tools as a compact activity", () => {
    let messages = reducePrimeEvent([], { type: "agent_start" });
    messages = reducePrimeEvent(messages, { type: "tool_execution_start", toolCallId: "x", toolName: "ipython", args: { code: "print('hello')" } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.activity).toMatchObject({ kind: "tool", state: "running", title: "Python" });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "x", result: { content: [{ type: "text", text: "hello" }] } });
    expect(messages[0]?.activity).toMatchObject({ kind: "tool", state: "success", summary: "hello" });
  });

  it("deduplicates repeated tool starts", () => {
    const start = { type: "tool_execution_start", toolCallId: "same", toolName: "read", args: { path: "part.py" } };
    const once = reducePrimeEvent([], start);
    expect(reducePrimeEvent(once, start)).toHaveLength(1);
  });

  it("shows the authoritative review result", () => {
    const messages = reducePrimeEvent([], { type: "message_end", message: { role: "custom", customType: "pi-cad.review-completed", details: { reviewId: "r1", status: "fail", result: { summary: "hinge collides" } } } });
    expect(messages[0]?.activity).toMatchObject({ kind: "review", state: "failed", summary: "hinge collides" });
  });

  it("labels review submission as requested until the verdict arrives", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "r1", toolName: "ipython", args: { code: "await cad.review.submit(final_commit)" } });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "r1", result: { details: { reviewId: "review-1", status: "running" } } });
    expect(messages[0]?.activity).toMatchObject({ kind: "review", state: "success", title: "Review requested" });
  });

  it("keeps structured simulation results available to the viewer", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "s1", toolName: "ipython", args: { code: "await cad.simulation.run(recipe='static')" } });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "s1", result: { details: { observation: { exports: [
      { name: "view", type: "image", path: "simulation/stress.png" },
      { name: "stress", type: "field", path: "simulation/stress.vtp", unit: "MPa" },
      { name: "peak", type: "scalar", value: 82, unit: "MPa" },
    ] } } } });
    expect(messages[0]?.activity).toMatchObject({ kind: "simulation", artifactPath: "simulation/stress.vtp", metrics: [{ label: "peak", value: "82 MPa" }] });
  });

  it("closes running tool activities when the user stops the Agent", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "s-stop", toolName: "ipython", args: { code: "await cad.simulation.run(recipe='static')" } });
    messages = reducePrimeEvent(messages, { type: "agent_abort" });
    expect(messages[0]?.activity).toMatchObject({ state: "denied", title: "Simulation stopped", summary: "Stopped by user" });
  });

  it("does not leak workflow result objects into the chat", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "w1", toolName: "ipython", args: { code: "await cad.workflow.advance('built')" } });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "w1", result: { content: [{ type: "text", text: "Commit(id='secret', variables=8, artifacts=2)" }], details: { currentPhase: "final_review" } } });
    expect(messages[0]?.activity?.summary).toBe("Now in final review");
    expect(messages[0]?.activity?.summary).not.toContain("Commit");
  });

  it("shows the thinking → retry → thinking → success order", () => {
    const states: string[] = [];
    const step = (state: any, event: any) => {
      state = reducePrimeEvent(state, event);
      states.push(state.at(-1)?.stream?.state ?? "");
      return state;
    };
    let messages = reducePrimeEvent([], { type: "agent_start" });
    messages = step(messages, { type: "message_update", message: { id: "a1", role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" } });
    messages = step(messages, { type: "message_end", message: { id: "a1", role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded_error" } });
    messages = step(messages, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "529 overloaded_error" });
    expect(messages.at(-1)?.stream?.retry).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 2_000, reason: "529 overloaded_error" });
    messages = step(messages, { type: "auto_retry_end", success: true, attempt: 2 });
    messages = step(messages, { type: "message_update", message: { id: "a2", role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "trying again" } });
    messages = step(messages, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Ready" } });
    messages = step(messages, { type: "message_end", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "Ready" }], stopReason: "stop" } });

    expect(states).toEqual(["thinking", "error", "retrying", "waiting", "thinking", "responding", "complete"]);
    expect(messages.at(-1)).toMatchObject({ text: "Ready", stream: { state: "complete" } });
  });

  it("passes a reasoning limit through as the terminal reason", () => {
    let messages = reducePrimeEvent([], { type: "agent_start" });
    messages = reducePrimeEvent(messages, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking very hard" } });
    messages = reducePrimeEvent(messages, {
      type: "message_end",
      message: { id: "limit", role: "assistant", content: [], stopReason: "error", diagnostics: [{ type: "provider_stream_failure", details: { kind: "reasoning_limit" } }] },
    });
    expect(messages[0]?.stream).toMatchObject({ state: "error", terminalReason: "reasoning_limit" });
    expect(messages[0]?.text).toBe("Stopped: the reasoning limit was reached.");
  });

  it("does not leave an empty needs_input row after an abnormal end", () => {
    let messages = reducePrimeEvent([], { type: "agent_start" });
    messages = reducePrimeEvent(messages, { type: "agent_status", status: { summary: " ", taskState: "needs_input" } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.stream).toMatchObject({ state: "error", terminalReason: "provider_error" });
    expect(["waiting", "thinking", "responding"]).not.toContain(messages[0]?.stream?.state);
  });

  it("leaves thinking as soon as the model emits output", () => {
    let messages = reducePrimeEvent([], { type: "agent_start" });
    messages = reducePrimeEvent(messages, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } });
    messages = reducePrimeEvent(messages, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } });
    expect(messages[0]?.stream?.state).toBe("responding");
  });
});
