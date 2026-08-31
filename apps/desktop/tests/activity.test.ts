import { describe, expect, it } from "vitest";
import { reducePrimeEvent } from "../src/renderer/src/lib/activity";

describe("Prime activity projection", () => {
  it("turns a CAD build call into one completed semantic card", () => {
    let messages = reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "b1", toolName: "ipython", args: { code: "await cad.model.build(source, output)" } });
    expect(messages[0]?.activity).toMatchObject({ kind: "build", state: "running" });
    messages = reducePrimeEvent(messages, { type: "tool_execution_end", toolCallId: "b1", result: { content: [{ type: "text", text: "built /workspace/bracket.step" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=", role: "isometric" }] } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.activity).toMatchObject({ state: "success", title: "Model built" });
    expect(messages[0]?.activity?.media?.[0]?.dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(messages[0]?.activity?.artifactPath).toBe("/workspace/bracket.step");
  });

  it("does not expose arbitrary Python as a product activity", () => {
    expect(reducePrimeEvent([], { type: "tool_execution_start", toolCallId: "x", toolName: "ipython", args: { code: "print('hello')" } })).toEqual([]);
  });

  it("shows the authoritative review result", () => {
    const messages = reducePrimeEvent([], { type: "message_end", message: { role: "custom", customType: "pi-cad.review-completed", details: { reviewId: "r1", status: "fail", result: { summary: "hinge collides" } } } });
    expect(messages[0]?.activity).toMatchObject({ kind: "review", state: "failed", summary: "hinge collides" });
  });
});
