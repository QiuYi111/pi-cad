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
import { ThinkingReconciler, type ThinkingDelivery } from "../src/renderer/src/components/thinking-sync";
import type { ModelChoice, RuntimeState, RuntimeStatus, ThinkingLevel } from "../src/shared/contracts";

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
    // That session is still reported on another level than the saved one, so the
    // marker for the level it was told does not settle the question.
    expect(pendingThinkingLevel(switched, "high", { sessionId: "session-b", level: "high" })).toBe("high");
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

  // A session that was already told `high` can be reported on `medium` later —
  // the old request landed last, or the sidecar recovered on its own. The fresh
  // report has to win over the delivered marker, or the split stays forever.
  it("reconciles a level Prime reports after that level was delivered", () => {
    const reported = status("ready", { sessionId: "session-b", thinking: "medium" });
    expect(pendingThinkingLevel(reported, "high", { sessionId: "session-b", level: "high" })).toBe("high");
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

/** Lets a test decide when one `set_thinking_level` call settles. */
function deferred() {
  let accept!: () => void;
  let decline!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => { accept = resolve; decline = reject; });
  return { promise, accept, decline };
}

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/**
 * A runtime that applies whichever level it accepted, like `noteThinking()`
 * does: the level is recorded when the RPC settles, not when it was sent.
 */
function recordingRuntime() {
  const sent: ThinkingLevel[] = [];
  const applied: ThinkingLevel[] = [];
  const calls: Array<ReturnType<typeof deferred>> = [];
  const send = (level: ThinkingLevel) => {
    sent.push(level);
    const call = deferred();
    calls.push(call);
    return call.promise.then(() => { applied.push(level); });
  };
  return { send, sent, applied, calls };
}

function recordingEvents() {
  const accepted: ThinkingDelivery[] = [];
  const rejected: string[] = [];
  const retries: number[] = [];
  const consistent: string[] = [];
  const unavailable: string[] = [];
  return {
    accepted,
    rejected,
    retries,
    consistent,
    unavailable,
    events: {
      accepted: (delivery: ThinkingDelivery) => { accepted.push(delivery); },
      rejected: (message: string) => { rejected.push(message); },
      retry: (delayMs: number) => { retries.push(delayMs); },
      consistent: () => { consistent.push("consistent"); },
      unavailable: () => { unavailable.push("unavailable"); },
    },
  };
}

/**
 * The request that is still on the wire is the only one that may touch the
 * reconciliation. Two levels in flight at once let the older one land last and
 * push the sidecar back to a level nobody asks for, and its late callback used
 * to clear the marker of the request that replaced it.
 */
describe("composer thinking reconciliation ordering", () => {
  it("holds a newer target until the request on the wire settles", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    // session-a runs `low` while `high` is saved, so `high` goes on the wire —
    // and it is slow to answer.
    reconciler.sync(status("ready", { sessionId: "session-a", thinking: "low" }), "high");
    expect(runtime.sent).toEqual(["high"]);

    // The target moves to session-b, which runs `high` while `medium` is now
    // saved, and that request is still pending. Sending `medium` now would let
    // the `high` request settle afterwards and leave the sidecar on high.
    reconciler.sync(status("ready", { sessionId: "session-b", thinking: "high" }), "medium");
    expect(runtime.sent).toEqual(["high"]);

    runtime.calls[0]!.accept();
    await flush();
    expect(runtime.sent).toEqual(["high", "medium"]);
    // `high` settled before `medium` went out, so `medium` is the level the
    // runtime ends on, and it is sent once — not once per late callback.
    expect(runtime.applied).toEqual(["high"]);
    expect(recorded.accepted).toEqual([]);

    runtime.calls[1]!.accept();
    await flush();
    expect(runtime.applied).toEqual(["high", "medium"]);
    expect(recorded.accepted).toEqual([{ sessionId: "session-b", level: "medium" }]);
    expect(recorded.rejected).toEqual([]);
    expect(recorded.retries).toEqual([]);
  });

  it("drops a late failure that a newer target has already replaced", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    reconciler.sync(status("ready", { sessionId: "session-a", thinking: "low" }), "high");
    reconciler.sync(status("ready", { sessionId: "session-b", thinking: "high" }), "medium");
    runtime.calls[0]!.decline(new Error("Prime rejected set_thinking_level"));
    await flush();

    // The split belongs to a session nobody is targeting any more: it must not
    // surface, and it must not schedule a retry that fights the newer target.
    expect(recorded.rejected).toEqual([]);
    expect(recorded.retries).toEqual([]);
    expect(runtime.sent).toEqual(["high", "medium"]);

    runtime.calls[1]!.accept();
    await flush();
    expect(runtime.applied).toEqual(["medium"]);
    expect(recorded.accepted).toEqual([{ sessionId: "session-b", level: "medium" }]);
  });

  it("still retries and reports a rejection that nothing replaced", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    const still = status("ready", { sessionId: "session-a", thinking: "low" });
    reconciler.sync(still, "high");
    // The same target seen again while it is on the wire is not a second call.
    reconciler.sync(still, "high");
    runtime.calls[0]!.decline(new Error("Prime rejected set_thinking_level"));
    await flush();

    expect(runtime.sent).toEqual(["high"]);
    expect(recorded.rejected).toHaveLength(1);
    expect(recorded.retries).toEqual([thinkingRetryDelayMs(1)]);

    // What the retry timer does: reconcile the same target once the RPC settled.
    reconciler.sync(still, "high");
    expect(runtime.sent).toEqual(["high", "high"]);
    runtime.calls[1]!.accept();
    await flush();
    expect(recorded.accepted).toEqual([{ sessionId: "session-a", level: "high" }]);
  });

  // A React effect can still run against a render from before the delivery
  // landed, so the component may ask for a level the runtime has already been
  // told. The marker lives with the reconciliation, not with the render, so
  // that ask is answered with "nothing to do" instead of a second RPC.
  it("does not send a level again when a stale render asks for it", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    const before = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.sync(before, "high");
    runtime.calls[0]!.accept();
    await flush();
    expect(recorded.accepted).toEqual([{ sessionId: "session-a", level: "high" }]);

    // The runtime has not published `high` yet, so this render still sees the
    // level the session ran before the delivery.
    reconciler.sync(before, "high");
    expect(runtime.sent).toEqual(["high"]);

    // Once the runtime reports the delivered level there is nothing to do either.
    reconciler.sync(status("ready", { sessionId: "session-a", thinking: "high" }), "high");
    expect(runtime.sent).toEqual(["high"]);
  });
});

/**
 * A reconciliation that is no longer needed has to say so. `accepted` only
 * fires for a delivery, so a warning about a split the runtime closed on its own
 * — the setting moves back onto the level the session runs, or the session is
 * switched to one that already matches — would otherwise stay on screen
 * forever, with no RPC left to clear it.
 */
describe("composer thinking reconciliation consistency", () => {
  it("reports the split resolved without sending another level", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    const split = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.sync(split, "high");
    runtime.calls[0]!.decline(new Error("Prime rejected set_thinking_level"));
    await flush();
    expect(recorded.rejected).toHaveLength(1);

    // The user moves the setting onto the level the session already runs: there
    // is nothing left to send, and the warning has to go with the split.
    reconciler.sync(split, "medium");
    expect(runtime.sent).toEqual(["high"]);
    expect(recorded.accepted).toEqual([]);
    expect(recorded.consistent).toHaveLength(1);
  });

  it("reports the split resolved when the setting returns to the delivered level", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    const runs = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.noteReading(runs);
    reconciler.sync(runs, "high");
    runtime.calls[0]!.accept();
    await flush();

    // The user moves away from the delivered level and that request is
    // rejected, so the split is visible on the component.
    reconciler.sync(runs, "low");
    runtime.calls[1]!.decline(new Error("Prime rejected set_thinking_level"));
    await flush();
    expect(recorded.rejected).toHaveLength(1);

    // Back onto the level this session was already told: the delivery still
    // answers it, so there is nothing to send and the warning goes with it.
    reconciler.sync(runs, "high");
    expect(runtime.sent).toEqual(["high", "low"]);
    expect(recorded.consistent).toHaveLength(1);
  });

  it("reconciles a reading Prime publishes after a delivery but not one already on screen", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    const before = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.noteReading(before);
    reconciler.sync(before, "high");
    // Prime publishes its level before the request settles, so the renderer
    // already holds this reading when the delivery lands.
    const published = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.noteReading(published);
    runtime.calls[0]!.accept();
    await flush();
    expect(recorded.accepted).toEqual([{ sessionId: "session-a", level: "high" }]);

    // That reading was on screen when the level landed, so it cannot be a newer
    // report about the session: the delivered level is not asked for again.
    reconciler.sync(published, "high");
    expect(runtime.sent).toEqual(["high"]);
    // Nothing is pending either: the delivery still answers this request.
    expect(recorded.consistent).toHaveLength(1);

    // A reading the renderer receives after the delivery is a report from
    // Prime, so the saved level is reconciled against it again.
    const later = status("ready", { sessionId: "session-a", thinking: "low" });
    reconciler.noteReading(later);
    reconciler.sync(later, "high");
    expect(runtime.sent).toEqual(["high", "high"]);
    expect(recorded.rejected).toEqual([]);
  });
});

/**
 * A runtime that cannot take a level is not a split waiting to be resolved. The
 * warning a rejection published names a session that has to exist for the level
 * to still matter, and the retry behind it asks the same runtime again. Once
 * the runtime is down both are pointless: the component has to be told, or the
 * composer keeps showing a retry that was already dropped.
 */
describe("composer thinking reconciliation availability", () => {
  it("clears the split and stops reconciling when the runtime stops taking levels", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    // The session runs `medium` while `high` is saved, and that reconcile is
    // rejected: the split is on screen with a retry scheduled for it.
    const running = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.sync(running, "high");
    runtime.calls[0]!.decline(new Error("Prime rejected set_thinking_level"));
    await flush();
    expect(recorded.rejected).toHaveLength(1);
    expect(recorded.retries).toEqual([thinkingRetryDelayMs(1)]);

    // The session is stopped. There is nothing left to sync, so the split is
    // reported as gone and the warning can follow it off the screen.
    const stopped = status("idle", { sessionId: "session-a" });
    reconciler.sync(stopped, "high");
    expect(recorded.unavailable).toHaveLength(1);

    // What the retry timer does if it still fires while the runtime is down:
    // nothing goes on the wire, and no second retry is scheduled.
    reconciler.sync(stopped, "high");
    expect(recorded.unavailable).toHaveLength(2);
    expect(runtime.sent).toEqual(["high"]);
    expect(recorded.retries).toHaveLength(1);

    // Starting again reads the session afresh. It still runs `medium`, so the
    // reconciliation starts over and the saved level goes back out.
    const restarted = status("ready", { sessionId: "session-a", thinking: "medium" });
    reconciler.sync(restarted, "high");
    expect(runtime.sent).toEqual(["high", "high"]);
    runtime.calls[1]!.accept();
    await flush();
    expect(recorded.accepted).toEqual([{ sessionId: "session-a", level: "high" }]);
  });

  it("drops a request that settles after the runtime stopped taking levels", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    reconciler.sync(status("ready", { sessionId: "session-a", thinking: "medium" }), "high");
    // The sidecar goes away while the `high` request is still on the wire.
    reconciler.sync(status("error", { sessionId: "session-a", message: "The worker exited unexpectedly." }), "high");
    expect(recorded.unavailable).toHaveLength(1);

    runtime.calls[0]!.decline(new Error("the session is gone"));
    await flush();

    // The failure belongs to a session that cannot be told anything any more:
    // no warning, and no retry asking a runtime that is down.
    expect(recorded.rejected).toEqual([]);
    expect(recorded.retries).toEqual([]);
  });

  it("drops a target that was queued when the runtime stopped taking levels", async () => {
    const runtime = recordingRuntime();
    const recorded = recordingEvents();
    const reconciler = new ThinkingReconciler({ send: runtime.send, events: recorded.events });

    reconciler.sync(status("ready", { sessionId: "session-a", thinking: "medium" }), "high");
    // The user picks `low` while `high` is still pending, so `low` waits for it.
    reconciler.sync(status("ready", { sessionId: "session-a", thinking: "medium" }), "low");
    // Then the session stops before the pending request settles.
    reconciler.sync(status("idle", { sessionId: "session-a" }), "low");

    runtime.calls[0]!.accept();
    await flush();

    expect(runtime.sent).toEqual(["high"]);
    expect(recorded.accepted).toEqual([]);
    expect(recorded.unavailable).toEqual(["unavailable"]);
  });
});
