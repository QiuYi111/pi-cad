import { describe, expect, it, vi } from "vitest";
import { AgentApiClient, AgentApiError } from "../electron/main/agent-api-client";

function bridge(pipe: () => Promise<{ stdout: string; stderr: string }>) {
  return {
    kind: "native" as const,
    async resolveRuntimePaths() { return { piCadRepo: "/repo", projectPath: "/project" }; },
    async commandPath() { return "node"; },
    async toRuntimePath(value: string) { return value; },
    async exec() { return { stdout: "", stderr: "" }; },
    pipe,
  };
}

vi.mock("../electron/main/runtime-bridge", () => ({ withCanonicalProjectEnvironment: async (_bridge: unknown, _project: string, command: string[]) => command }));

describe("AgentApiClient", () => {
  it("reports the error envelope on stdout when the Agent API exits non-zero", async () => {
    const envelope = JSON.stringify({ ok: false, error: { code: "TRANSFER_UNAVAILABLE", message: "the desktop app is not running" } });
    const failing = Object.assign(new Error("(node:1) Warning: EnvHttpProxyAgent is experimental"), { stdout: `${envelope}\n`, stderr: "warning" });
    const client = new AgentApiClient(bridge(async () => { throw failing; }) as never);
    const error = await client.request({} as never, { op: "transfer-export" }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentApiError);
    expect(error.code).toBe("TRANSFER_UNAVAILABLE");
    expect(error.message).toBe("the desktop app is not running");
  });

  it("keeps the original error when stdout holds no envelope", async () => {
    const failing = Object.assign(new Error("spawn failed"), { stdout: "", stderr: "spawn failed" });
    const client = new AgentApiClient(bridge(async () => { throw failing; }) as never);
    await expect(client.request({} as never, { op: "x" })).rejects.toThrow("spawn failed");
  });
});
