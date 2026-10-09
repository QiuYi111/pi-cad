import { describe, expect, it, vi } from "vitest";
import { ActivityMonitor, startActivityReporter, ACTIVITY_WINDOW_MS } from "../src/activity.js";
import { RingBuffer } from "../src/ring.js";

const text = (value: string) => new TextEncoder().encode(value);

describe("RingBuffer", () => {
  it("keeps only the most recent bytes", () => {
    const ring = new RingBuffer(10);
    ring.push(text("abcdef"));
    ring.push(text("ghijkl"));
    const kept = Buffer.concat(ring.snapshot()).toString();
    expect(kept).toBe("cdefghijkl");
  });

  it("keeps the tail of a single oversized push", () => {
    const ring = new RingBuffer(4);
    ring.push(text("0123456789"));
    expect(Buffer.concat(ring.snapshot()).toString()).toBe("6789");
  });
});

describe("ActivityMonitor", () => {
  it("is idle with nothing running and no recent messages", () => {
    const monitor = new ActivityMonitor({ now: () => 0 });
    expect(monitor.snapshot()).toEqual({ active: false, reason: "idle" });
  });

  it("is active for recent bridge messages until the window passes", () => {
    let now = 1_000;
    const monitor = new ActivityMonitor({ now: () => now });
    monitor.noteMessage();
    now += ACTIVITY_WINDOW_MS - 1;
    expect(monitor.snapshot().reason).toBe("bridge-message");
    now += 1;
    expect(monitor.snapshot().active).toBe(false);
  });

  it("ignores configured commands", () => {
    const monitor = new ActivityMonitor({ ignoredCommands: ["sleep"] });
    monitor.processStarted("a", ["/usr/bin/sleep", "30"]);
    expect(monitor.snapshot().active).toBe(false);
    monitor.processStarted("b", ["cat"]);
    expect(monitor.snapshot()).toEqual({ active: true, reason: "process" });
    monitor.processStopped("b");
    expect(monitor.snapshot().active).toBe(false);
  });

  it("tracks Prime turns from agent_start and agent_end lines, even split across chunks", () => {
    const monitor = new ActivityMonitor({ ignoredCommands: ["prime"] });
    monitor.processStarted("p", ["prime", "rpc"]);
    monitor.stdout("p", text('{"type":"agent_st'));
    expect(monitor.snapshot().active).toBe(false);
    monitor.stdout("p", text('art"}\n{"type":"message_update"}\n'));
    expect(monitor.snapshot()).toEqual({ active: true, reason: "prime-turn" });
    monitor.stdout("p", text('{"type":"agent_end"}\nnot json\n'));
    expect(monitor.snapshot().active).toBe(false);
  });

  it("reporter posts snapshots", async () => {
    const monitor = new ActivityMonitor({ now: () => 0 });
    monitor.noteMessage();
    const post = vi.fn(async () => undefined);
    const reporter = startActivityReporter({ monitor, post });
    await reporter.tick();
    expect(post).toHaveBeenCalledWith({ active: true, reason: "bridge-message" });
    reporter.stop();
  });
});
