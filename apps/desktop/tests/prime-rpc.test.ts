import { describe, expect, it, vi } from "vitest";
import { ensureRuntimeReady } from "../electron/main/prime-rpc";
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
