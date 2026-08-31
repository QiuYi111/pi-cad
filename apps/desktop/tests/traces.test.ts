import { describe, expect, it } from "vitest";
import { TraceStore } from "../electron/main/traces";

describe("trajectory confinement", () => {
  it("rejects a trajectory outside the selected project", async () => {
    const bridge = { resolveRuntimePaths: async () => ({ projectPath: "/projects/a" }) };
    await expect(new TraceStore(bridge as never).read({} as never, "/projects/b/.prime-sessions/run.jsonl")).rejects.toThrow(/escapes/);
  });

  it("reads a canonical project-local JSONL trajectory", async () => {
    const bridge = {
      resolveRuntimePaths: async () => ({ projectPath: "/projects/a" }),
      exec: async (args: string[]) => {
        if (args[0] === "realpath") return { stdout: args.at(-1)?.endsWith("run.jsonl") ? "/projects/a/.prime-sessions/run.jsonl\n" : "/projects/a/.prime-sessions\n", stderr: "" };
        return { stdout: "{\"type\":\"session\"}\n{\"type\":\"message\"}\n", stderr: "" };
      },
    };
    await expect(new TraceStore(bridge as never).read({} as never, "/projects/a/.prime-sessions/run.jsonl")).resolves.toHaveLength(2);
  });
});
