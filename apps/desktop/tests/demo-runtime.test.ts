import { describe, expect, it } from "vitest";
import { DemoRuntime } from "../electron/main/demo-runtime";
import type { AppSettings, RuntimeStatus } from "../src/shared/contracts";

const settings: AppSettings = {
  distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
  provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace", reviewer: { mode: "inherit" },
} as AppSettings;

describe("demo runtime phases", () => {
  it("walks retry, provider wait and completion without the renderer guessing", async () => {
    const runtime = new DemoRuntime();
    const phases: Array<RuntimeStatus["phase"]> = [];
    runtime.on("status", (status: RuntimeStatus) => phases.push(status.phase));
    await runtime.start(settings);
    await runtime.prompt("Provider retry please");
    expect(phases).toContain("starting_turn");
    expect(phases).toContain("retrying");
    expect(phases).toContain("provider_wait");
    expect(phases).toContain("responding");
    expect(runtime.status).toMatchObject({ state: "ready", phase: "ready", terminalReason: "completed" });
  });

  it("holds a reasoning limit as a live phase until the retry grace resolves it", async () => {
    const runtime = new DemoRuntime();
    const seen: RuntimeStatus[] = [];
    runtime.on("status", (status: RuntimeStatus) => seen.push(status));
    await runtime.start(settings);
    const running = runtime.prompt("Reasoning limit please");
    await new Promise((accept) => setTimeout(accept, 300));
    // Inside the grace window the runtime reports the limit but has not ended the turn.
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "reasoning_limit" });
    expect(runtime.status.terminalReason).toBeUndefined();
    expect(runtime.status.turn?.finishedAt).toBeUndefined();
    await running;
    expect(seen.some((status) => status.phase === "reasoning_limit")).toBe(true);
    expect(seen.some((status) => status.phase === "retrying")).toBe(true);
    expect(runtime.status).toMatchObject({ state: "ready", phase: "ready", terminalReason: "completed" });
  });

  it("confirms stop with an aborted terminal state", async () => {
    const runtime = new DemoRuntime();
    await runtime.start(settings);
    const running = runtime.prompt("Long calculation");
    await new Promise((accept) => setTimeout(accept, 120));
    expect(runtime.status).toMatchObject({ state: "streaming", phase: "running_tool" });
    const stopping = runtime.abort();
    expect(runtime.status).toMatchObject({ state: "stopping", phase: "stopping" });
    await stopping;
    expect(runtime.status).toMatchObject({ state: "ready", phase: "aborted", terminalReason: "aborted" });
    await running;
  });
});
