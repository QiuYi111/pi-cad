import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/renderer/src/components/Conversation";
import type { ChatMessage, RuntimeStatus } from "../src/shared/contracts";

const now = Date.now();

function status(value: Partial<RuntimeStatus>): RuntimeStatus {
  return { state: "streaming", checks: [], ...value };
}

const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "Build a bracket", createdAt: now - 13_000 },
  { id: "a1", role: "assistant", text: "", createdAt: now - 12_000, stream: { startedAt: now - 12_000 } },
];

describe("conversation turn row", () => {
  it("shows the runtime phase with the three labelled clocks", () => {
    const html = renderToStaticMarkup(<Conversation messages={messages} status={status({
      phase: "retrying",
      retry: { attempt: 1, maxAttempts: 3, delayMs: 4_000 },
      turn: { id: "t1", kind: "prompt", startedAt: now - 12_000, phaseStartedAt: now - 4_000, lastEventAt: now - 6_000, retryAttempt: 1, phase: "retrying" },
    })} />);
    expect(html).toContain("Retrying 1/3");
    expect(html).toContain("phase 4s");
    expect(html).toContain("silent 6s");
    expect(html).toContain("turn 12s");
  });

  it("keeps the silent reading when only runtime chatter is still arriving", () => {
    const html = renderToStaticMarkup(<Conversation messages={messages} status={status({
      phase: "thinking",
      turn: { id: "t1", kind: "prompt", startedAt: now - 30_000, phaseStartedAt: now - 20_000, lastEventAt: now - 1_000, lastProviderEventAt: now - 12_000, retryAttempt: 0, phase: "thinking" },
    })} />);
    expect(html).toContain("Thinking");
    expect(html).toContain("silent 12s");
    expect(html).toContain("turn 30s");
  });

  it("keeps the row while a tool runs, when no assistant text exists yet", () => {
    const html = renderToStaticMarkup(<Conversation messages={[messages[0]!]} status={status({
      phase: "running_tool",
      turn: { id: "t1", kind: "prompt", startedAt: now - 7_000, phaseStartedAt: now - 2_000, lastEventAt: now - 1_000, retryAttempt: 0, phase: "running_tool" },
    })} />);
    expect(html).toContain("Running tool");
    expect(html).toContain("turn 7s");
  });

  it("shows the reasoning limit instead of an endless thinking timer", () => {
    const html = renderToStaticMarkup(<Conversation messages={[{ ...messages[1]!, stream: { startedAt: now - 668_000, finishedAt: now } }]} status={status({
      state: "ready",
      phase: "reasoning_limit",
      terminalReason: "reasoning_limit",
      turn: { id: "t1", kind: "prompt", startedAt: now - 668_000, phaseStartedAt: now - 5_000, lastEventAt: now - 5_000, retryAttempt: 0, phase: "reasoning_limit", finishedAt: now },
    })} />);
    expect(html).toContain("Reasoning limit");
    expect(html).toContain('data-terminal-reason="reasoning_limit"');
    expect(html).not.toContain("Thinking");
    expect(html).not.toContain("668s");
  });

  it("leaves a completed answer without a phase row", () => {
    const html = renderToStaticMarkup(<Conversation messages={[{ ...messages[1]!, text: "Done", stream: { startedAt: now - 3_000, finishedAt: now } }]} status={status({
      state: "ready",
      phase: "ready",
      terminalReason: "completed",
      turn: { id: "t1", kind: "prompt", startedAt: now - 3_000, phaseStartedAt: now - 3_000, lastEventAt: now - 3_000, retryAttempt: 0, phase: "ready", finishedAt: now },
    })} />);
    expect(html).not.toContain("stream-state");
  });

  it("keeps the row and its clocks while a failure waits out the retry grace", () => {
    const html = renderToStaticMarkup(<Conversation messages={messages} status={status({
      phase: "failed",
      reason: "provider_unavailable",
      message: "529 overloaded_error: Overloaded",
      turn: { id: "t1", kind: "prompt", startedAt: now - 9_000, phaseStartedAt: now - 1_000, lastEventAt: now - 1_000, retryAttempt: 0, phase: "failed", error: "529 overloaded_error: Overloaded" },
    })} />);
    expect(html).toContain("Failed");
    expect(html).not.toContain("data-terminal-reason");
    expect(html).toContain("turn 9s");
  });

  it("marks the row terminal only once the runtime ends the turn", () => {
    const html = renderToStaticMarkup(<Conversation messages={[{ ...messages[1]!, stream: { startedAt: now - 4_000, finishedAt: now } }]} status={status({
      state: "ready",
      phase: "aborted",
      terminalReason: "aborted",
      turn: { id: "t1", kind: "prompt", startedAt: now - 4_000, phaseStartedAt: now - 1_000, lastEventAt: now - 1_000, retryAttempt: 0, phase: "aborted", finishedAt: now, terminalReason: "aborted" },
    })} />);
    expect(html).toContain("Stopped");
    expect(html).toContain('data-terminal-reason="aborted"');
    expect(html).not.toContain("data-timer");
  });
});
