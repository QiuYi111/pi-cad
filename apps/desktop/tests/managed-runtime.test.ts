import { describe, expect, it, vi } from "vitest";
import { updateManagedRuntime } from "../electron/main/managed-runtime";
import type { RuntimeBridge } from "../electron/main/runtime-bridge";
import type { AppSettings, RuntimeStatus } from "../src/shared/contracts";

const settings = { piCadRepo: "", primeAgentRepo: "" } as AppSettings;
const stale: RuntimeStatus = { state: "error", checks: [
  { id: "wsl", label: "WSL", status: "ready", detail: "Ubuntu", installable: false },
  { id: "prime", label: "Prime", status: "missing", detail: "Update available", installable: true },
] };
const ready: RuntimeStatus = { state: "idle", checks: stale.checks.map((item) => ({ ...item, status: "ready" })) };

describe("managed runtime updates", () => {
  it("does not admit startup at 78% while Python setup is still running", async () => {
    let finish!: (status: RuntimeStatus) => void;
    let progress!: (status: RuntimeStatus) => void;
    const bridge = {
      kind: "wsl", bundledRuntimePath: "/bundle", check: vi.fn().mockResolvedValue(stale),
      install: vi.fn((_settings, onStatus) => {
        progress = onStatus;
        return new Promise<RuntimeStatus>((resolve) => { finish = resolve; });
      }),
    } as unknown as RuntimeBridge;
    let admitted = false;
    const update = updateManagedRuntime(bridge, settings, vi.fn()).then(() => { admitted = true; });
    await vi.waitFor(() => expect(bridge.install).toHaveBeenCalled());
    progress({ ...stale, state: "installing", progress: 0.78 });
    await Promise.resolve();
    expect(admitted).toBe(false);
    finish(ready);
    await update;
    expect(admitted).toBe(true);
  });

  it("propagates a dependency failure instead of treating unpacking as completion", async () => {
    const bridge = {
      kind: "wsl", bundledRuntimePath: "/bundle", check: vi.fn().mockResolvedValue(stale),
      install: vi.fn().mockRejectedValue(new Error("kernel installation failed")),
    } as unknown as RuntimeBridge;
    await expect(updateManagedRuntime(bridge, settings, vi.fn())).rejects.toThrow("kernel installation failed");
  });

  it("leaves explicitly selected development checkouts alone", async () => {
    const bridge = { bundledRuntimePath: "/bundle", check: vi.fn(), install: vi.fn() } as unknown as RuntimeBridge;
    await updateManagedRuntime(bridge, { ...settings, primeAgentRepo: "/dev/prime" }, vi.fn());
    expect(bridge.install).not.toHaveBeenCalled();
  });
});
