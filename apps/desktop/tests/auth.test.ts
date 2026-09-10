import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AuthController } from "../electron/main/auth";
import type { AppSettings } from "../src/shared/contracts";

const settings: AppSettings = {
  distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
  provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
  reviewer: { mode: "inherit" },
};

class FakeChild extends EventEmitter {
  killed = false;
  kill() { this.killed = true; return true; }
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { writable: true, write: vi.fn() };
}

function bridge(stdout = "{}") {
  const child = new FakeChild();
  return {
    child,
    value: {
      resolveRuntimePaths: vi.fn().mockResolvedValue({ piCadRepo: "/opt/pi-cad", primeAgentRepo: "/opt/prime", projectPath: "/workspace" }),
      homeDirectory: vi.fn().mockResolvedValue("/home/prime"),
      commandPath: vi.fn().mockResolvedValue("/usr/bin/node"),
      exec: vi.fn().mockResolvedValue({ stdout, stderr: "" }),
      spawn: vi.fn().mockReturnValue(child),
    },
  };
}

describe("desktop OAuth", () => {
  it("runs token exchange with Node environment proxy support", async () => {
    const runtime = bridge();
    const controller = new AuthController(runtime.value as any);
    await controller.login(settings, "openai-codex");
    expect(runtime.value.spawn).toHaveBeenCalledWith([
      "/usr/bin/node", "--use-env-proxy", "/opt/pi-cad/scripts/desktop-openai-oauth.mjs", "/opt/prime", "/home/prime/.prime/agent", "openai-codex",
    ]);
  });

  it("resets the active runtime before reporting successful login", async () => {
    const runtime = bridge();
    const resetRuntime = vi.fn().mockResolvedValue(undefined);
    const controller = new AuthController(runtime.value as any, resetRuntime);
    const statuses: string[] = [];
    controller.on("status", (status) => statuses.push(status.state));
    await controller.login(settings, "anthropic");
    runtime.child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "auth_complete" })}\n`));
    await vi.waitFor(() => expect(resetRuntime).toHaveBeenCalledOnce());
    expect(statuses.at(-1)).toBe("signed-in");
    expect(runtime.value.spawn).toHaveBeenCalledWith(expect.arrayContaining(["anthropic"]));
  });

  it("cancels a provider login without touching stored credentials", async () => {
    const runtime = bridge(); const controller = new AuthController(runtime.value as any); await controller.login(settings, "github-copilot");
    await expect(controller.cancel()).resolves.toMatchObject({ state: "signed-out" });
    expect(runtime.value.exec).not.toHaveBeenCalledWith(["rm", "-f", "/home/prime/.prime/agent/auth.json"]);
  });
});
