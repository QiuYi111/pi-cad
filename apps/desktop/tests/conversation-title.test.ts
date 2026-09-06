import { describe, expect, it } from "vitest";
import { automaticConversationTitle, needsAutomaticConversationTitle } from "../src/renderer/src/lib/conversation-title";

describe("automatic conversation titles", () => {
  it("uses the first request as a short useful title", () => {
    expect(automaticConversationTitle("你好，请帮我设计一个电机支架。还要检查强度。"))
      .toBe("请帮我设计一个电机支架。");
    expect(automaticConversationTitle("Build a compact bracket with four mounting holes and a reinforced rib"))
      .toBe("Build a compact bracket with four…");
  });

  it("only replaces generated placeholder names", () => {
    expect(needsAutomaticConversationTitle("01a07566-78fe-7077-8ae2-807158c0e210", "01a07566-78fe-7077-8ae2-807158c0e210")).toBe(true);
    expect(needsAutomaticConversationTitle("Folding stand", "demo-trace")).toBe(false);
  });
});
