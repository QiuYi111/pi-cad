import { describe, expect, it, vi } from "vitest";
import { PrimeConfigService } from "../electron/main/prime-config";
import type { AppSettings } from "../src/shared/contracts";

const settings = { distro: "Ubuntu", projectPath: "/work", piCadRepo: "", primeAgentRepo: "", provider: "zai", model: "glm", thinking: "medium", permission: "workspace", reviewer: { mode: "inherit" } } as AppSettings;
describe("Prime configuration bridge", () => {
  it("passes secrets over stdin and never through argv", async () => {
    const bridge = { resolveRuntimePaths: vi.fn().mockResolvedValue({ piCadRepo: "/pi", primeAgentRepo: "/prime", projectPath: "/work" }), homeDirectory: vi.fn().mockResolvedValue("/home/u"), commandPath: vi.fn().mockResolvedValue("/node"), exec: vi.fn().mockResolvedValue({ stdout: '{"provider":"zai","state":"signed-in"}', stderr: "" }) };
    await new PrimeConfigService(bridge as any).setApiKey(settings, "zai", "secret-value");
    const [argv, options] = bridge.exec.mock.calls[0];
    expect(argv.join(" ")).not.toContain("secret-value");
    expect(options.input).toContain("secret-value");
  });
  it("loads the catalog before a conversation runtime exists", async () => {
    const bridge = { resolveRuntimePaths: vi.fn().mockResolvedValue({ piCadRepo: "/pi", primeAgentRepo: "/prime", projectPath: "" }), homeDirectory: vi.fn().mockResolvedValue("/home/u"), commandPath: vi.fn().mockResolvedValue("/node"), exec: vi.fn().mockResolvedValue({ stdout: '{"providers":[],"favorites":[],"defaults":{}}', stderr: "" }) };
    await expect(new PrimeConfigService(bridge as any).catalog(settings)).resolves.toMatchObject({ providers: [] });
  });
});
