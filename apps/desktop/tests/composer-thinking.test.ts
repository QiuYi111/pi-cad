import { describe, expect, it } from "vitest";
import {
  normalizeThinkingLevel,
  pendingThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelOptions,
  thinkingRequestKey,
  thinkingRetryDelayMs,
  thinkingSyncMessage,
} from "../src/renderer/src/components/Composer";
import type { ModelChoice, RuntimeState, RuntimeStatus } from "../src/shared/contracts";

const model = (thinkingLevels?: ModelChoice["thinkingLevels"]): ModelChoice => ({ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, thinkingLevels });
const status = (state: RuntimeState, extra: Partial<RuntimeStatus> = {}): RuntimeStatus => ({ state, checks: [], ...extra });

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
    expect(pendingThinkingLevel(status("starting"), "high")).toBeUndefined();
    expect(pendingThinkingLevel(status("installing"), "high")).toBeUndefined();
    expect(pendingThinkingLevel(status("ready"), "high")).toBe("high");
  });

  it("sends a level once per session and again only when the saved level moves", () => {
    const sent = { sessionId: "session-a", level: "high" as const };
    expect(pendingThinkingLevel(status("ready", { sessionId: "session-a" }), "high", sent)).toBeUndefined();
    expect(pendingThinkingLevel(status("streaming", { sessionId: "session-a" }), "high", sent)).toBeUndefined();
    expect(pendingThinkingLevel(status("streaming", { sessionId: "session-a" }), "medium", sent)).toBe("medium");
    expect(pendingThinkingLevel(status("idle", { sessionId: "session-a" }), "medium", sent)).toBeUndefined();
  });

  // A switch can restore a session that runs another level while the saved
  // setting never moves. The marker from the previous session must not be
  // mistaken for "the running session already has this level".
  it("reconciles a session that runs another level than the saved setting", () => {
    const delivered = { sessionId: "session-a", level: "high" as const };
    const switched = status("ready", { sessionId: "session-b", thinking: "medium" });
    expect(pendingThinkingLevel(switched, "high", delivered)).toBe("high");
    // Once that session has been told, the same level is not sent again.
    expect(pendingThinkingLevel(switched, "high", { sessionId: "session-b", level: "high" })).toBeUndefined();
    // The status the switch published is enough even without a marker.
    expect(pendingThinkingLevel(switched, "high")).toBe("high");
  });

  // Prime reports the level the live session holds, so a session that already
  // runs the saved level needs nothing, and one that runs another level does.
  it("trusts the level Prime reports over the last one sent", () => {
    expect(pendingThinkingLevel(status("ready", { sessionId: "session-b", thinking: "high" }), "high")).toBeUndefined();
    expect(pendingThinkingLevel(status("ready", { sessionId: "session-b", thinking: "medium" }), "high")).toBe("high");
    expect(pendingThinkingLevel(status("ready", { sessionId: "session-b" }), "high", { sessionId: "session-b", level: "high" })).toBeUndefined();
  });

  // A rejected RPC must leave the marker empty, otherwise the next
  // reconciliation is skipped as "already delivered" even though the runtime
  // still runs the old level.
  it("keeps asking while the runtime has not accepted the level", () => {
    const switched = status("ready", { sessionId: "session-b", thinking: "medium" });
    expect(pendingThinkingLevel(switched, "high")).toBe("high");
    expect(pendingThinkingLevel(switched, "high", undefined)).toBe("high");
    expect(pendingThinkingLevel(switched, "high", { sessionId: "session-b", level: "medium" })).toBe("high");
  });
});

describe("composer thinking sync retry", () => {
  it("keys a reconciliation by session and level", () => {
    expect(thinkingRequestKey("session-b", "high")).not.toBe(thinkingRequestKey("session-a", "high"));
    expect(thinkingRequestKey("session-b", "high")).not.toBe(thinkingRequestKey("session-b", "medium"));
    expect(thinkingRequestKey(undefined, "high")).toBe(":high");
  });

  it("backs off a rejected runtime instead of hammering it", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((failures) => thinkingRetryDelayMs(failures));
    expect(delays[0]).toBeGreaterThan(0);
    for (let index = 1; index < delays.length; index += 1) expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!);
    expect(delays.at(-1)!).toBeLessThanOrEqual(30_000);
    expect(thinkingRetryDelayMs(0)).toBe(delays[0]);
  });

  it("names the failed RPC in the visible split", () => {
    const message = thinkingSyncMessage(new Error("Prime rejected set_thinking_level"));
    expect(message).toContain("Prime rejected set_thinking_level");
    expect(thinkingSyncMessage("offline")).toContain("offline");
  });
});
