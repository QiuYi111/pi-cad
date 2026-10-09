import { describe, expect, it, vi } from "vitest";
import {
  CAD_PYTHON_LOCK_MARKER,
  WslBridge,
  parseDefaultGateway,
  systemProxyUrls,
  windowsProxyEnvironment,
  wslNetworkingIsMirrored,
  wslProxyEnvironment,
} from "../electron/main/wsl";
import type { AppSettings, RuntimeStatus } from "../src/shared/contracts";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

// Every process call is mocked: wsl.exe, reg.exe and ip are never spawned.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: execFileMock });
  return { ...actual, execFile, spawn: vi.fn() };
});

describe("WSL proxy forwarding", () => {
  it("rewrites loopback proxies to the Windows gateway in NAT mode", () => {
    const gateway = parseDefaultGateway("default via 172.20.144.1 dev eth0 proto kernel\n");
    expect(gateway).toBe("172.20.144.1");

    const { env, unresolvedLoopback } = wslProxyEnvironment({
      HTTP_PROXY: "http://localhost:7890",
      http_proxy: "http://localhost:7890",
      HTTPS_PROXY: "http://[::1]:7890",
      NO_PROXY: "localhost,127.0.0.1",
    }, { mirrored: false, gateway });
    expect(env.HTTP_PROXY).toBe("http://172.20.144.1:7890");
    expect(env.http_proxy).toBe("http://172.20.144.1:7890");
    expect(env.HTTPS_PROXY).toBe("http://172.20.144.1:7890");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(unresolvedLoopback).toBe(false);

    // Without a gateway the loopback proxy is not forwarded at all.
    const unresolved = wslProxyEnvironment({ HTTP_PROXY: "http://127.0.0.1:7890" }, { mirrored: false });
    expect(unresolved.env.HTTP_PROXY).toBeUndefined();
    expect(unresolved.unresolvedLoopback).toBe(true);
  });

  it("keeps loopback proxies in mirrored mode and strips credentials from forwarded URLs", () => {
    expect(wslNetworkingIsMirrored("[wsl2]\r\nnetworkingMode=Mirrored\r\n")).toBe(true);
    expect(wslNetworkingIsMirrored("[wsl2]\nmemory=8GB\n")).toBe(false);

    const mirrored = wslProxyEnvironment({ HTTP_PROXY: "http://user:s3cret@localhost:7890" }, { mirrored: true });
    expect(mirrored.env.HTTP_PROXY).toBe("http://localhost:7890");

    const nat = wslProxyEnvironment({ HTTPS_PROXY: "http://alice:pw@proxy.corp:8080" }, { mirrored: false });
    expect(nat.env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
  });

  it("falls back to the WinINET system proxy only after environment variables", () => {
    expect(systemProxyUrls("1", "http=proxy.corp:8080;https=secure.corp:8443")).toEqual({
      http: "http://proxy.corp:8080",
      https: "http://secure.corp:8443",
    });
    expect(systemProxyUrls("0", "proxy.corp:8080")).toEqual({});

    const system = systemProxyUrls("1", "proxy.corp:8080");
    const merged = windowsProxyEnvironment({ HTTP_PROXY: "http://env.corp:3128" }, {}, system);
    expect(merged.HTTP_PROXY).toBe("http://env.corp:3128");
    expect(merged.HTTPS_PROXY).toBe("http://proxy.corp:8080");
  });
});

describe("CAD Python update path", () => {
  it("re-runs CAD Python setup when the lock hash marker does not match", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    const bridge = new WslBridge("Ubuntu", "C:\\Pi-CAD\\runtime");
    const settings = {
      distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
      provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
      reviewer: { mode: "inherit" },
    } as AppSettings;
    const check = (id: string, status = "ready") => ({ id, label: id, status, detail: "test", installable: true });
    const before = {
      state: "error", message: "Install runtime",
      checks: [check("wsl"), check("python"), check("uv"), check("node"), check("bwrap"), check("prime"), check("picad", "missing")],
    } as RuntimeStatus;
    vi.spyOn(bridge, "check")
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ state: "idle", checks: [] } as RuntimeStatus);
    vi.spyOn(bridge, "resolveRuntimePaths").mockResolvedValue({
      piCadRepo: "/home/tester/runtime/pi-cad", primeAgentRepo: "/home/tester/runtime/prime-agent", projectPath: "/workspace",
    });
    vi.spyOn(bridge, "toLinuxPath").mockResolvedValue("/bundle");
    vi.spyOn(bridge, "homeDirectory").mockResolvedValue("/home/tester");
    vi.spyOn(bridge, "exec").mockResolvedValue({ stdout: "", stderr: "" });
    // The shell probe decides "ready" from imports plus the marker; here the marker mismatches.
    const pipe = vi.spyOn(bridge, "pipe").mockImplementation(async (_args, input) => ({
      stdout: input.includes("import build123d") ? "cadpython=missing\n" : "",
      stderr: "",
    }));

    await bridge.install(settings);

    const inputs = pipe.mock.calls.map(([, input]) => input);
    const probe = inputs.find((input) => input.includes("import build123d"));
    const setup = inputs.find((input) => input.includes("npm run setup:python"));
    expect(probe).toContain(`python/.venv/${CAD_PYTHON_LOCK_MARKER}`);
    expect(probe).toContain("cat python/uv.lock python/pyproject.toml | sha256sum");
    expect(setup).toBeDefined();
    expect(setup).toContain(`python/.venv/${CAD_PYTHON_LOCK_MARKER}`);
    // Blender system libraries are verified as installed packages, not by a dpkg -s exit code.
    expect(execFileMock.mock.calls.some(([, args]) => String(args).includes("dpkg-query -W -f='${Status}' libsm6"))).toBe(true);
  });
});
