import { describe, expect, it, vi } from "vitest";
import { WslBridge } from "../electron/main/wsl";
import type { AppSettings } from "../src/shared/contracts";

describe("WSL path conversion", () => {
  const bridge = new WslBridge("Ubuntu");

  it("converts packaged Windows resource paths without shell parsing", async () => {
    await expect(bridge.toLinuxPath("C:\\Program Files\\Pi-CAD\\resources\\runtime"))
      .resolves.toBe("/mnt/c/Program Files/Pi-CAD/resources/runtime");
  });

  it("converts WSL UNC paths directly", async () => {
    await expect(bridge.toLinuxPath("\\\\wsl.localhost\\Ubuntu\\home\\jingyi\\project"))
      .resolves.toBe("/home/jingyi/project");
  });

  it("uses the bundled Prime runtime unless the user selects another checkout", async () => {
    vi.spyOn(bridge, "homeDirectory").mockResolvedValue("/home/tester");
    const settings: AppSettings = {
      distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
      provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
      reviewer: { mode: "inherit" },
    };
    await expect(bridge.resolveRuntimePaths(settings)).resolves.toMatchObject({
      primeAgentRepo: "/home/tester/.local/share/pi-cad-desktop/runtime/prime-agent",
    });
  });
});
