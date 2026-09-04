import { describe, expect, it, vi } from "vitest";
import { ensureRuntimeReady, PrimeRpc, sandboxSessionPath } from "../electron/main/prime-rpc";
import type { AppSettings, RuntimeStatus } from "../src/shared/contracts";

const settings: AppSettings = {
  distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
  provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
  reviewer: { mode: "inherit" },
};

const ready: RuntimeStatus = { state: "idle", checks: [
  { id: "prime", label: "Prime Agent", status: "ready", detail: "ready", installable: true },
] };

describe("Prime runtime setup", () => {
  it("maps host session files into the sandbox workspace", () => {
    expect(sandboxSessionPath("C:\\project\\.prime-sessions\\abc-123.jsonl"))
      .toBe("/workspace/.prime-sessions/abc-123.jsonl");
    expect(() => sandboxSessionPath("../escape.txt")).toThrow("Invalid session path");
  });
  it("recovers the first prompt after abort through Prime steering", async () => {
    const runtime = new PrimeRpc({} as never);
    const request = vi.spyOn(runtime, "request")
      .mockRejectedValueOnce(new Error("Cannot admit a session action while queued session input is suspended."))
      .mockResolvedValueOnce(undefined);
    await expect(runtime.prompt("continue")).resolves.toBeUndefined();
    expect(request.mock.calls.map(([type]) => type)).toEqual(["prompt", "steer"]);
  });
  it("uses an existing runtime without reinstalling", async () => {
    const bridge = { check: vi.fn().mockResolvedValue(ready), install: vi.fn() };
    await expect(ensureRuntimeReady(bridge as any, settings)).resolves.toEqual(ready);
    expect(bridge.install).not.toHaveBeenCalled();
  });

  it("installs a missing bundled runtime before Prime starts", async () => {
    const missing: RuntimeStatus = { state: "error", checks: [
      { id: "prime", label: "Prime Agent", status: "missing", detail: "missing", installable: true },
    ] };
    const bridge = { check: vi.fn().mockResolvedValue(missing), install: vi.fn().mockResolvedValue(ready) };
    await expect(ensureRuntimeReady(bridge as any, settings)).resolves.toEqual(ready);
    expect(bridge.install).toHaveBeenCalledOnce();
  });
});
