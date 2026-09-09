import { describe, expect, it, vi } from "vitest";
import { WslBridge, classifyWslInstallResult, forwardWslRuntimeEnvironment, nodeInstallScript, runtimeChecksReady, wslInstallHeartbeat, wslInstallPowerShellCommand } from "../electron/main/wsl";
import { engineeringKnowledgeProbe, withCanonicalProjectEnvironment } from "../electron/main/runtime-bridge";
import type { AppSettings } from "../src/shared/contracts";
import { setupErrorMessage } from "../src/renderer/src/pages/FirstRun";

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

  it("can isolate a bundled runtime installation without changing the WSL user home", async () => {
    const previous = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT;
    process.env.PI_CAD_DESKTOP_RUNTIME_ROOT = "/tmp/pi-cad-runtime-e2e";
    vi.spyOn(bridge, "homeDirectory").mockResolvedValue("/home/tester");
    try {
      await expect(bridge.resolveRuntimePaths({
        distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
        provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
        reviewer: { mode: "inherit" },
      })).resolves.toMatchObject({
        piCadRepo: "/tmp/pi-cad-runtime-e2e/pi-cad",
        primeAgentRepo: "/tmp/pi-cad-runtime-e2e/prime-agent",
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CAD_DESKTOP_RUNTIME_ROOT;
      else process.env.PI_CAD_DESKTOP_RUNTIME_ROOT = previous;
    }
  });
});

describe("first-run setup errors", () => {
  it("does not mistake the architecture guard embedded in a failed command for the failure", () => {
    const error = new Error('Command failed: wsl.exe bash -lc case "$picad_node_machine" in *) echo "Unsupported WSL CPU architecture: uname=$picad_node_machine dpkg=$picad_dpkg_arch" ;; esac\ncurl: (56) OpenSSL SSL_read: connection reset');
    expect(setupErrorMessage(error)).toBe("curl: (56) OpenSSL SSL_read: connection reset");
  });

  it("still reports a real unsupported architecture", () => {
    expect(setupErrorMessage(new Error("Unsupported WSL CPU architecture: uname=riscv64 dpkg=riscv64")))
      .toBe("当前 WSL 处理器架构无法识别：uname=riscv64 dpkg=riscv64");
  });
});

describe("WSL runtime environment", () => {
  it("streams the multi-line runtime check over stdin", async () => {
    const bridge = new WslBridge("Ubuntu", "/bundle");
    vi.spyOn(bridge, "toLinuxPath").mockImplementation(async (value) => value === "/bundle" ? "/bundle" : value);
    vi.spyOn(bridge, "homeDirectory").mockResolvedValue("/home/tester");
    vi.spyOn(bridge, "resolveRuntimePaths").mockResolvedValue({ piCadRepo: "/runtime/pi-cad", primeAgentRepo: "/runtime/prime-agent", projectPath: "/workspace" });
    vi.spyOn(bridge, "exec").mockResolvedValue({ stdout: "Ubuntu\n", stderr: "" });
    const pipe = vi.spyOn(bridge, "pipe").mockResolvedValue({
      stdout: "node=22.23.2\nuv=/home/tester/.local/bin/uv\nbwrap=/usr/bin/bwrap\nparaview=\nprime=ready\npicad=ready\nknowledge=4\nbundle=ready\npython=/usr/bin/python3\n",
      stderr: "",
    });

    await expect(bridge.check({
      distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "/runtime/pi-cad", primeAgentRepo: "/runtime/prime-agent",
      provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace", reviewer: { mode: "inherit" },
    })).resolves.toMatchObject({ state: "idle" });

    expect(pipe).toHaveBeenCalledWith(["bash", "-s"], expect.stringContaining("printf 'node='"), 120_000);
  });

  it("installs the optional torch-fem component as WSL root and verifies it", async () => {
    const bridge = new WslBridge("Ubuntu");
    vi.spyOn(bridge, "resolveRuntimePaths").mockResolvedValue({ piCadRepo: "/runtime/pi-cad", primeAgentRepo: "", projectPath: "/workspace" });
    const exec = vi.spyOn(bridge, "exec").mockResolvedValue({ stdout: "", stderr: "" });
    const status = await bridge.installSimulationComponent({} as AppSettings);
    expect(status.state).toBe("ready");
    expect(exec).toHaveBeenCalledWith(["bash", "/runtime/pi-cad/scripts/bootstrap-torch-fem-runtimes.sh"], { user: "root", timeout: 1_800_000 });
  });

  it("forwards state and distillation roots without forwarding unrelated host secrets", () => {
    const env = forwardWslRuntimeEnvironment({
      WSLENV: "PATH/p",
      PI_CAD_CANONICAL_PROJECT_DIR: "/tmp/canonical",
      PI_CAD_EXPERIENCE_ROOT: "/tmp/experience",
      PI_CAD_DISTILL_COMMAND_JSON: "[\"node\"]",
      UNRELATED_SECRET: "do-not-forward",
    });
    expect(env.WSLENV?.split(":")).toEqual([
      "PATH/p", "PI_CAD_CANONICAL_PROJECT_DIR", "PI_CAD_EXPERIENCE_ROOT", "PI_CAD_DISTILL_COMMAND_JSON",
    ]);
    expect(env.WSLENV).not.toContain("UNRELATED_SECRET");
  });

  it("pins desktop Agent API calls to the configured authority directory", async () => {
    const previous = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    process.env.PI_CAD_CANONICAL_PROJECT_DIR = "C:\\state\\project";
    try {
      const argv = await withCanonicalProjectEnvironment({
        toRuntimePath: async () => "/mnt/c/state/project",
      } as never, "/workspace/project", ["node", "agent-api.mjs"]);
      expect(argv).toEqual(["env", "PI_CAD_CANONICAL_PROJECT_DIR=/mnt/c/state/project", "node", "agent-api.mjs"]);
    } finally {
      if (previous === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
      else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previous;
    }
  });
});

describe("bundled engineering knowledge", () => {
  it("requires the progressively disclosed modeling, mechanism, assembly, and manufacturing skills", () => {
    const probe = engineeringKnowledgeProbe("/runtime/pi-cad");
    expect(probe.count).toBe(4);
    expect(probe.command).toContain("parametric-cad-modeling/SKILL.md");
    expect(probe.command).toContain("mechanical-design/references/design-reasoning.md");
    expect(probe.command).toContain("assembly-design/references/interfaces.md");
    expect(probe.command).toContain("design-for-manufacturing/references/geometry-rules.md");
  });
});

describe("WSL first-install status", () => {
  it("downloads the Node archive format published for both supported WSL architectures", () => {
    const script = nodeInstallScript();
    expect(script).toContain("x86_64:*|amd64:*|*:amd64) picad_node_arch=x64");
    expect(script).toContain("aarch64:*|arm64:*|*:arm64) picad_node_arch=arm64");
    expect(script).toContain("dpkg --print-architecture");
    expect(script).toContain("linux-$picad_node_arch.tar.xz");
    expect(script).toContain("tar -xJf");
    expect(script).not.toContain("linux-$picad_node_arch.tar.gz");
  });

  it("does not block the base runtime on optional ParaView", () => {
    expect(runtimeChecksReady([
      { id: "wsl", label: "WSL", status: "ready", detail: "Ubuntu", installable: true },
      { id: "node", label: "Node", status: "ready", detail: "22", installable: true },
      { id: "python", label: "Python", status: "ready", detail: "3", installable: true },
      { id: "uv", label: "uv", status: "ready", detail: "uv", installable: true },
      { id: "bwrap", label: "Bubblewrap", status: "ready", detail: "bwrap", installable: true },
      { id: "prime", label: "Prime", status: "ready", detail: "ready", installable: true },
      { id: "picad", label: "Reify", status: "ready", detail: "ready", installable: true },
      { id: "paraview", label: "ParaView", status: "missing", detail: "optional", installable: true },
    ])).toBe(true);
  });

  it("does not let the hidden installer wait for Ubuntu's interactive user setup", () => {
    const command = wslInstallPowerShellCommand("Ubuntu");
    expect(command).toContain("'--no-launch'");
    expect(command).toContain("'--web-download'");
    expect(command).toContain(".WaitForExit()");
    expect(command).toContain("wsl.exe exited with code");
    expect(command).not.toMatch(/Start-Process.+\s-Wait(?:\s|;)/);
  });

  it("keeps a silent Windows installer visibly alive", () => {
    expect(wslInstallHeartbeat(65_000)).toMatchObject({
      state: "installing",
      progress: 0.2,
      elapsedSeconds: 65,
    });
    expect(wslInstallHeartbeat(65_000).message).toContain("Windows is downloading");
  });

  it("requires restart when the elevated installer succeeds but Ubuntu is not listed", () => {
    expect(classifyWslInstallResult({ exitCode: 0, distroPresent: false })).toMatchObject({
      state: "action-required",
      action: "restart-windows",
    });
  });

  it("requires Ubuntu initialization when the distro exists but cannot run a command", () => {
    expect(classifyWslInstallResult({ exitCode: 0, distroPresent: true, distroReady: false })).toMatchObject({
      state: "action-required",
      action: "initialize-ubuntu",
    });
  });

  it("continues setup after copying a previously missing bundled runtime", async () => {
    const bridge = new WslBridge("Ubuntu", "C:\\Pi-CAD\\runtime");
    const settings: AppSettings = {
      distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
      provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
      reviewer: { mode: "inherit" },
    };
    const missing = {
      state: "error", message: "Install runtime", checks: [
        { id: "wsl", label: "WSL", status: "ready", detail: "Ubuntu", installable: true },
        { id: "prime", label: "Prime", status: "missing", detail: "missing", installable: true },
        { id: "picad", label: "Reify", status: "missing", detail: "missing", installable: true },
      ],
    } as const;
    const ready = { state: "idle", checks: missing.checks.map((item) => ({ ...item, status: "ready" as const })) } as const;
    vi.spyOn(bridge, "check").mockResolvedValueOnce(missing).mockResolvedValueOnce(ready);
    vi.spyOn(bridge, "resolveRuntimePaths").mockResolvedValue({
      piCadRepo: "/home/tester/runtime/pi-cad", primeAgentRepo: "/home/tester/runtime/prime-agent", projectPath: "/workspace",
    });
    vi.spyOn(bridge, "toLinuxPath").mockResolvedValue("/bundle");
    vi.spyOn(bridge, "homeDirectory").mockResolvedValue("/home/tester");
    const exec = vi.spyOn(bridge, "exec").mockResolvedValue({ stdout: "", stderr: "" });
    const pipe = vi.spyOn(bridge, "pipe").mockResolvedValue({ stdout: "", stderr: "" });

    await expect(bridge.install(settings)).resolves.toMatchObject({ state: "idle" });
    expect(exec).toHaveBeenCalled();
    expect(pipe.mock.calls.some(([, input]) => input.includes("setup:python"))).toBe(true);
  });

  it("streams shell programs over stdin instead of placing them on the Windows command line", async () => {
    const bridge = new WslBridge("Ubuntu");
    const missing = {
      state: "error", checks: [
        { id: "wsl", label: "WSL", status: "ready", detail: "Ubuntu", installable: true },
        { id: "node", label: "Node", status: "missing", detail: "missing", installable: true },
      ],
    } as const;
    vi.spyOn(bridge, "check").mockResolvedValueOnce(missing).mockResolvedValueOnce({ state: "idle", checks: [] });
    vi.spyOn(bridge, "resolveRuntimePaths").mockResolvedValue({ piCadRepo: "/runtime/pi-cad", primeAgentRepo: "/runtime/prime-agent", projectPath: "/workspace" });
    vi.spyOn(bridge, "exec").mockResolvedValue({ stdout: "", stderr: "" });
    const pipe = vi.spyOn(bridge, "pipe").mockResolvedValue({ stdout: "", stderr: "" });

    await bridge.install({
      distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "/runtime/pi-cad", primeAgentRepo: "/runtime/prime-agent",
      provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace", reviewer: { mode: "inherit" },
    });

    expect(pipe).toHaveBeenCalledWith(["bash", "-s"], expect.stringContaining("picad_node_machine=$(uname -m"), 10 * 60_000);
  });

});
