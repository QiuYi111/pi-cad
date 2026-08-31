import { describe, expect, it } from "vitest";
import { ViewerBackend } from "../electron/main/viewer";

describe("desktop viewer bridge", () => {
  it("maps sandbox artifacts back into the active project", async () => {
    let command: string[] = [];
    const bridge = {
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
      commandPath: async () => "/home/user/.local/bin/uv",
      toLinuxPath: async (path: string) => path,
      exec: async (args: string[]) => { command = args; return { stdout: JSON.stringify({ source: args.at(-1), parts: [], bounds: { min: [0,0,0], max: [1,1,1] } }), stderr: "" }; },
    };
    const result = await new ViewerBackend(bridge as never).loadStep({} as never, "/workspace/build/part.step");
    expect(command.at(-1)).toBe("/projects/bracket/build/part.step");
    expect(result.source).toBe("/projects/bracket/build/part.step");
  });

  it("rejects models outside the active project", async () => {
    const bridge = {
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", projectPath: "/projects/bracket" }),
      toLinuxPath: async () => "/etc/passwd.step",
    };
    await expect(new ViewerBackend(bridge as never).loadStep({} as never, "/etc/passwd.step")).rejects.toThrow(/active project/);
  });
});
