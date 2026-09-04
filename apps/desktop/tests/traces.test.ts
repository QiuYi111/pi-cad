import { describe, expect, it } from "vitest";
import { desktopDistillationEnvironment, desktopDistillationPath, TraceStore } from "../electron/main/traces";
import { distillationTitle } from "../src/renderer/src/lib/distillation";

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

  it("shows saved ratings beside old conversations", async () => {
    const bridge = {
      resolveRuntimePaths: async () => ({ projectPath: "/projects/a" }),
      homeDirectory: async () => "/home/tester",
      commandPath: async () => "/usr/bin/node",
      exec: async (args: string[]) => args[0] === "cat"
        ? { stdout: `${JSON.stringify({ session_path: "/projects/a/.prime-sessions/run.jsonl", quality: 2, difficulty: 4, feedback: "wrong orientation" })}\n`, stderr: "" }
        : { stdout: `${JSON.stringify({ id: "run", path: "/projects/a/.prime-sessions/run.jsonl", title: "Stand", updatedAt: 1, turns: 4, toolCalls: 1 })}\n`, stderr: "" },
    };
    await expect(new TraceStore(bridge as never).list({} as never)).resolves.toMatchObject([
      { id: "run", evaluation: { quality: 2, difficulty: 4, feedback: "wrong orientation" } },
    ]);
  });
});

describe("distillation status", () => {
  it("does not label a failed job as complete", () => {
    expect(distillationTitle("running")).toBe("Distilling experience");
    expect(distillationTitle("complete")).toBe("Distillation complete");
    expect(distillationTitle("failed")).toBe("Distillation failed");
  });

  it("inherits the desktop author model unless explicitly overridden", () => {
    expect(desktopDistillationEnvironment({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "low",
    } as never, {})).toEqual([
      "PI_CAD_DISTILL_PROVIDER=openai-codex",
      "PI_CAD_DISTILL_MODEL=gpt-5.6-sol",
      "PI_CAD_DISTILL_THINKING=low",
    ]);
    expect(desktopDistillationEnvironment({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "low",
    } as never, {
      PI_CAD_DISTILL_PROVIDER: "zai",
      PI_CAD_DISTILL_MODEL: "glm-5.3-flash",
      PI_CAD_DISTILL_THINKING: "minimal",
    })).toEqual([
      "PI_CAD_DISTILL_PROVIDER=zai",
      "PI_CAD_DISTILL_MODEL=glm-5.3-flash",
      "PI_CAD_DISTILL_THINKING=minimal",
    ]);
    expect(desktopDistillationPath("/home/tester/.local/bin/node")).toBe(
      "PATH=/home/tester/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });
});
