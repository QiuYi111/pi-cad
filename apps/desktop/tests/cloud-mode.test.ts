import { describe, expect, it } from "vitest";
import { assertCloudAvailable, createRuntimeBridge, runtimeBridgeKey, STAGE_1_CLOUD_UNAVAILABLE } from "../electron/main/cloud-mode";
import { RemoteBridge } from "../electron/main/remote-bridge";
import type { RuntimeBridge } from "../electron/main/runtime-bridge";
import type { AppSettings } from "../src/shared/contracts";

const settings = (value: Partial<AppSettings>): AppSettings => ({
  distro: "Ubuntu",
  projectPath: "",
  piCadRepo: "",
  primeAgentRepo: "",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "minimal",
  permission: "workspace",
  reviewer: { mode: "inherit" },
  remotePublish: { enabled: false, allowedRemotes: ["origin"] },
  onboardingComplete: true,
  mode: "local",
  ...value,
});

const fakeLocal = { kind: "native" } as unknown as RuntimeBridge;
const fakeRemote = { kind: "remote" } as unknown as RuntimeBridge;
const factories = { local: () => fakeLocal, remote: () => fakeRemote };

describe("bridge selection by mode", () => {
  it("uses the remote bridge in cloud mode, keyed by the signed-in account", () => {
    const cloud = settings({ mode: "cloud", cloud: { baseUrl: "https://example.test", userEmail: "ann@example.com" } });
    expect(createRuntimeBridge(cloud, "linux", factories)).toEqual({ key: "cloud:ann@example.com", bridge: fakeRemote });
    expect(createRuntimeBridge(cloud, "win32", factories).bridge).toBe(fakeRemote);
  });

  it("keeps the local runtime in local mode", () => {
    const local = settings({ mode: "local" });
    expect(createRuntimeBridge(local, "linux", factories)).toEqual({ key: "native:linux", bridge: fakeLocal });
    expect(createRuntimeBridge(local, "win32", factories)).toEqual({ key: "wsl:Ubuntu", bridge: fakeLocal });
  });

  it("changes the key when the account changes, so the bridge is replaced", () => {
    const first = settings({ mode: "cloud", cloud: { baseUrl: "https://example.test", userEmail: "ann@example.com" } });
    const second = settings({ mode: "cloud", cloud: { baseUrl: "https://example.test", userEmail: "bo@example.com" } });
    expect(runtimeBridgeKey(first, "linux")).not.toBe(runtimeBridgeKey(second, "linux"));
  });

  it("creates a real RemoteBridge for cloud mode when the factory does", () => {
    const cloud = settings({ mode: "cloud", cloud: { baseUrl: "https://example.test" } });
    const created = createRuntimeBridge(cloud, "linux", {
      local: () => fakeLocal,
      remote: () => new RemoteBridge({ projectId: () => undefined, connect: async () => { throw new Error("unused"); } }),
    });
    expect(created.bridge).toBeInstanceOf(RemoteBridge);
    expect(created.bridge.kind).toBe("remote");
  });
});

describe("cloud mode guards", () => {
  it("refuses Blender and ParaView work in cloud mode with the stage 1 message", () => {
    const cloud = settings({ mode: "cloud" });
    expect(() => assertCloudAvailable(cloud, "Blender")).toThrow(`Blender：${STAGE_1_CLOUD_UNAVAILABLE}`);
    expect(() => assertCloudAvailable(cloud, "ParaView")).toThrow(STAGE_1_CLOUD_UNAVAILABLE);
  });

  it("allows Blender and ParaView work in local mode", () => {
    expect(() => assertCloudAvailable(settings({ mode: "local" }), "Blender")).not.toThrow();
  });
});
