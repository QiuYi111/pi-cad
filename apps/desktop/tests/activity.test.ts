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

  it("deduplicates a build image exposed through content and attachment details", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "b2", toolName: "ipython", args: { code: "await cad.model.build(source, output)" } });
    const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=", name: "iso" };
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "b2", result: { details: { attachments: [image] }, content: [{ type: "text", text: "built" }, image] } });
    expect(messages[0]?.activity?.media).toHaveLength(1);
    expect(messages[0]?.activity?.media?.[0]?.label).toBe("iso");
  });

  it("does not expose arbitrary Python as a product activity", () => {
    expect(reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "x", toolName: "ipython", args: { code: "print('hello')" } })).toEqual([]);
  });

  it("shows the authoritative review result", () => {
    const messages = reducePrimeEvent([], { type: "message_end", message: { role: "custom", customType: "pi-cad.review-completed", details: { reviewId: "r1", status: "fail", result: { summary: "hinge collides" } } } });
    expect(messages[0]?.activity).toMatchObject({ kind: "review", state: "failed", summary: "hinge collides" });
  });

  it("keeps structured simulation results available to the viewer", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "s1", toolName: "ipython", args: { code: "await cad.simulation.run(recipe='static')" } });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "s1", result: { details: { observation: { exports: [
      { name: "stress", type: "field", path: "simulation/stress.vtp", unit: "MPa" },
      { name: "peak", type: "scalar", value: 82, unit: "MPa" },
    ] } } } });
    expect(messages[0]?.activity).toMatchObject({ kind: "simulation", artifactPath: "simulation/stress.vtp", metrics: [{ label: "peak", value: "82 MPa" }] });
  });

  it("does not leak workflow result objects into the chat", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "w1", toolName: "ipython", args: { code: "await cad.workflow.advance('built')" } });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "w1", result: { content: [{ type: "text", text: "Commit(id='secret', variables=8, artifacts=2)" }], details: { currentPhase: "final_review" } } });
    expect(messages[0]?.activity?.summary).toBe("Now in final review");
    expect(messages[0]?.activity?.summary).not.toContain("Commit");
  });
});
