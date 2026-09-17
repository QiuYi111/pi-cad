import { describe, expect, it } from "vitest";
import { normalizeThinkingLevel, pendingThinkingLevel, thinkingLevelLabel, thinkingLevelOptions } from "../src/renderer/src/components/Composer";
import type { ModelChoice, RuntimeState, RuntimeStatus } from "../src/shared/contracts";

const model = (thinkingLevels?: ModelChoice["thinkingLevels"]): ModelChoice => ({ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, thinkingLevels });
const status = (state: RuntimeState): RuntimeStatus => ({ state, checks: [] });

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

  it("keeps the saved level until the catalog answers", () => {
    expect(thinkingLevelOptions(undefined, "medium")).toContain("medium");
    expect(normalizeThinkingLevel(undefined, "medium")).toBe("medium");
    expect(normalizeThinkingLevel({ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, "xhigh")).toBe("xhigh");
  });
});

describe("composer thinking level clamping", () => {
  it("walks Prime's level order instead of the catalog's order", () => {
    // `off` is listed first, but the request was xhigh, so the closest level
    // above it wins. Collapsing to `off` would silently switch reasoning off.
    expect(normalizeThinkingLevel(model(["off", "minimal", "low", "medium", "high"]), "xhigh")).toBe("high");
    expect(normalizeThinkingLevel(model(["off", "minimal", "low", "medium", "high"]), "max")).toBe("high");
  });

  it("keeps a reasoning request on when only a higher level is available", () => {
    expect(normalizeThinkingLevel(model(["off", "high"]), "medium")).toBe("high");
    expect(normalizeThinkingLevel(model(["off", "high"]), "xhigh")).toBe("high");
    expect(normalizeThinkingLevel(model(["off", "high"]), "off")).toBe("off");
  });

  it("prefers the next level up, then the next level down", () => {
    expect(normalizeThinkingLevel(model(["off", "minimal", "low", "medium"]), "high")).toBe("medium");
    expect(normalizeThinkingLevel(model(["off", "minimal", "medium", "high"]), "low")).toBe("medium");
    expect(normalizeThinkingLevel(model(["off", "minimal"]), "max")).toBe("minimal");
  });
});

describe("composer thinking level delivery", () => {
  it("waits for the runtime before sending a folded level", () => {
    expect(pendingThinkingLevel(status("starting"), "high", undefined)).toBeUndefined();
    expect(pendingThinkingLevel(status("installing"), "high", undefined)).toBeUndefined();
    expect(pendingThinkingLevel(status("ready"), "high", undefined)).toBe("high");
  });

  it("sends a level once and again only when the saved level moves", () => {
    expect(pendingThinkingLevel(status("ready"), "high", "high")).toBeUndefined();
    expect(pendingThinkingLevel(status("streaming"), "high", "high")).toBeUndefined();
    expect(pendingThinkingLevel(status("streaming"), "medium", "high")).toBe("medium");
    expect(pendingThinkingLevel(status("idle"), "medium", "high")).toBeUndefined();
  });
});
