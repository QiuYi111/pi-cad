import { describe, expect, it } from "vitest";
import { phaseLabel } from "../src/renderer/src/components/StatusBar";
import type { RuntimeStatus } from "../src/shared/contracts";

const status = (value: Partial<RuntimeStatus>): RuntimeStatus => ({ state: "streaming", checks: [], ...value });

describe("runtime status label", () => {
  it("shows the runtime phase instead of guessing from the stream", () => {
    expect(phaseLabel(status({ phase: "waiting_provider" }))).toBe("Waiting for model");
    expect(phaseLabel(status({ phase: "thinking" }))).toBe("Thinking");
    expect(phaseLabel(status({ phase: "responding" }))).toBe("Responding");
    expect(phaseLabel(status({ phase: "running_tool" }))).toBe("Running tool");
    expect(phaseLabel(status({ phase: "provider_wait" }))).toBe("Waiting for provider");
    expect(phaseLabel(status({ phase: "stopping", state: "stopping" }))).toBe("Stopping");
    expect(phaseLabel(status({ phase: "provider_timeout" }))).toBe("Provider timeout");
    expect(phaseLabel(status({ phase: "rpc_timeout" }))).toBe("Runtime RPC timeout");
    expect(phaseLabel(status({ phase: "reasoning_limit" }))).toBe("Reasoning limit");
  });

  it("names the retry attempt and the terminal outcome", () => {
    expect(phaseLabel(status({ phase: "retrying", retry: { attempt: 2, maxAttempts: 3, delayMs: 4_000, reason: "provider_unavailable" } }))).toBe("Retrying 2/3");
    expect(phaseLabel(status({ phase: "aborted", state: "ready", terminalReason: "aborted" }))).toBe("Stopped");
    expect(phaseLabel(status({ phase: "failed", state: "ready", terminalReason: "provider_error" }))).toBe("Failed");
    expect(phaseLabel({ state: "idle", checks: [] })).toBe("idle");
  });
});
