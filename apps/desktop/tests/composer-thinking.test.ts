import { describe, expect, it } from "vitest";
import { normalizeThinkingLevel, thinkingLevelLabel, thinkingLevelOptions } from "../src/renderer/src/components/Composer";
import type { ModelChoice } from "../src/shared/contracts";

const model = (thinkingLevels?: ModelChoice["thinkingLevels"]): ModelChoice => ({ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, thinkingLevels });

describe("composer thinking selector", () => {
  it("offers only the levels the catalog reports for the model", () => {
    expect(thinkingLevelOptions(model(["minimal", "low", "medium", "high", "xhigh"]), "medium")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  it("shows a binary-thinking model as off plus its single level", () => {
    expect(thinkingLevelOptions(model(["off", "high"]), "off")).toEqual(["off", "high"]);
    expect(thinkingLevelLabel("off")).toBe("Off");
  });

  it("drops a saved level the catalog does not list instead of offering it back", () => {
    expect(thinkingLevelOptions(model(["off", "high"]), "xhigh")).toEqual(["off", "high"]);
    expect(thinkingLevelOptions(model(["minimal", "low", "medium"]), "max")).toEqual(["minimal", "low", "medium"]);
  });

  it("folds a saved level into one the model really supports", () => {
    expect(normalizeThinkingLevel(model(["off", "high"]), "xhigh")).toBe("off");
    expect(normalizeThinkingLevel(model(["minimal", "low", "medium"]), "medium")).toBe("medium");
  });

  it("keeps the saved level until the catalog answers", () => {
    expect(thinkingLevelOptions(undefined, "medium")).toContain("medium");
    expect(normalizeThinkingLevel(undefined, "medium")).toBe("medium");
    expect(normalizeThinkingLevel({ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, "xhigh")).toBe("xhigh");
  });
});
