import { describe, expect, it } from "vitest";
import { phaseLabel, turnPhaseView, turnTimerParts } from "../src/renderer/src/lib/runtime-phase";
import type { RuntimeStatus } from "../src/shared/contracts";

const now = Date.now();

function status(value: Partial<RuntimeStatus>): RuntimeStatus {
  return { state: "streaming", checks: [], ...value };
}

describe("runtime turn projection", () => {
  it("names every phase the runtime can report", () => {
    expect(phaseLabel(status({ phase: "thinking" }))).toBe("Thinking");
    expect(phaseLabel(status({ phase: "waiting_provider" }))).toBe("Waiting for model");
    expect(phaseLabel(status({ phase: "provider_wait" }))).toBe("Waiting for provider");
    expect(phaseLabel(status({ phase: "running_tool" }))).toBe("Running tool");
    expect(phaseLabel(status({ phase: "retrying", retry: { attempt: 1, maxAttempts: 3, delayMs: 4_000 } }))).toBe("Retrying 1/3");
    expect(phaseLabel(status({ phase: "stalled", reason: "provider_silent" }))).toBe("No provider response");
    expect(phaseLabel(status({ phase: "reasoning_limit" }))).toBe("Reasoning limit");
  });

  it("reads the three clocks from the runtime turn, never from the turn total alone", () => {
    const view = turnPhaseView(status({
      phase: "thinking",
      turn: { id: "t1", kind: "prompt", startedAt: now - 12_000, phaseStartedAt: now - 4_000, lastEventAt: now - 6_000, retryAttempt: 0, phase: "thinking" },
    }), now);
    expect(view).toMatchObject({ label: "Thinking", terminal: false, turnSeconds: 12, phaseSeconds: 4, silentSeconds: 6, showSilent: true });
    expect(turnTimerParts(view!).map((part) => part.text)).toEqual(["phase 4s", "silent 6s", "turn 12s"]);
  });

  it("hides the silent reading until the provider has been quiet for a while", () => {
    const turn = { id: "t1", kind: "prompt" as const, startedAt: now - 30_000, phaseStartedAt: now - 2_000, lastEventAt: now - 1_000, retryAttempt: 0, phase: "thinking" as const };
    const view = turnPhaseView(status({ phase: "thinking", turn }), now)!;
    expect(view.showSilent).toBe(false);
    expect(turnTimerParts(view).map((part) => part.key)).toEqual(["phase", "turn"]);
  });

  it("keeps an abnormal end visible and drops the live clocks", () => {
    const view = turnPhaseView(status({
      state: "ready",
      phase: "reasoning_limit",
      terminalReason: "reasoning_limit",
      turn: { id: "t1", kind: "prompt", startedAt: now - 668_000, phaseStartedAt: now - 5_000, lastEventAt: now - 5_000, retryAttempt: 0, phase: "reasoning_limit", finishedAt: now },
    }), now);
    expect(view).toMatchObject({ label: "Reasoning limit", terminal: true });
    expect(turnTimerParts(view!)).toEqual([]);
  });

  it("shows nothing once a turn completed with an answer", () => {
    expect(turnPhaseView(status({
      state: "ready",
      phase: "ready",
      terminalReason: "completed",
      turn: { id: "t1", kind: "prompt", startedAt: now - 9_000, phaseStartedAt: now - 9_000, lastEventAt: now - 9_000, retryAttempt: 0, phase: "ready", finishedAt: now },
    }), now)).toBeUndefined();
  });

  it("shows nothing before the runtime has a turn", () => {
    expect(turnPhaseView(status({ state: "ready", phase: "ready" }), now)).toBeUndefined();
  });
});
