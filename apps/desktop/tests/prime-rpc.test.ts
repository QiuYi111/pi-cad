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
  it("sets a bounded normalized automatic session name", async () => {
    const runtime = new PrimeRpc({} as never);
    const request = vi.spyOn(runtime, "request").mockResolvedValue(undefined);
    await runtime.setSessionName(`  折叠   手机支架 ${"长".repeat(100)}  `);
    const [, payload] = request.mock.calls[0]!;
    expect(request.mock.calls[0]![0]).toBe("set_session_name");
    expect(payload.name).toHaveLength(80);
    expect(payload.name.startsWith("折叠 手机支架 ")).toBe(true);
  });
  it("restores a saved session directly when Prime is stopped", async () => {
    const runtime = new PrimeRpc({} as never);
    const start = vi.spyOn(runtime, "start").mockResolvedValue({ state: "ready", checks: [], sessionId: "saved" });
    const messages = vi.spyOn(runtime, "getMessages").mockResolvedValue([{ role: "user", text: "saved" }]);
    const request = vi.spyOn(runtime, "request");
    const path = "C:\\project\\.prime-sessions\\saved.jsonl";
    await expect(runtime.switchSession(path, settings)).resolves.toEqual([{ role: "user", text: "saved" }]);
    expect(start).toHaveBeenCalledWith(settings, path);
    expect(messages).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalledWith("switch_session", expect.anything());
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

  it("rejects a missing saved project before spawning Prime", async () => {
    const spawn = vi.fn(() => { throw new Error("spawned missing project"); });
    const bridge = {
      check: vi.fn().mockResolvedValue(ready),
      install: vi.fn(),
      resolveRuntimePaths: vi.fn().mockResolvedValue({
        piCadRepo: "/runtime/pi-cad",
        primeAgentRepo: "/runtime/prime-agent",
        projectPath: "/tmp/deleted-project",
      }),
      exec: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      homeDirectory: vi.fn().mockResolvedValue("/home/tester"),
      commandPath: vi.fn().mockResolvedValue("/usr/bin/node"),
      spawn,
    };

    await expect(new PrimeRpc(bridge as any).start(settings))
      .rejects.toThrow("Project folder no longer exists");
    expect(bridge.exec).toHaveBeenCalledWith(["test", "-d", "/tmp/deleted-project"]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
