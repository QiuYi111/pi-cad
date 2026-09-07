import { describe, expect, it } from "vitest";
import { WorkflowStore } from "../electron/main/workflows";
import { shouldRefreshWorkflow } from "../src/renderer/src/components/WorkflowRail";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("desktop workflow projection", () => {
  it("uses the pinned run snapshot projected by the sidecar", async () => {
    const projected = {
      run: {
        id: "run-1", workflowId: "custom.branching", workflowHash: "abc", phase: "verify", status: "active",
        updatedAt: "now", phaseHistory: ["intake", "verify"],
        phases: [{ id: "verify", title: "Verify", purpose: "Check", status: "active", transitions: [{ event: "retry", target: "intake" }], capabilities: ["probe.run"], obligations: ["evidence"] }],
      },
    };
    const projectPath = await mkdtemp(join(tmpdir(), "pi-cad-workflow-"));
    await mkdir(join(projectPath, ".pi-cad"));
    await writeFile(join(projectPath, ".pi-cad", "status.json"), JSON.stringify(projected));
    const current = await new WorkflowStore({ revealPath: async (path: string) => path } as never).current({ projectPath, distro: "Ubuntu" } as never);
    expect(current.workflowId).toBe("custom.branching");
    expect(current.workflowHash).toBe("abc");
    expect(current.phases[0]?.transitions).toEqual([{ event: "retry", target: "intake" }]);
    expect(current.phases[0]?.capabilities).toEqual(["probe.run"]);
  });

  it("returns an explicit idle state when no project is selected", async () => {
    await expect(new WorkflowStore({} as never).current({ projectPath: "" } as never)).resolves.toMatchObject({ phases: [], phaseHistory: [] });
  });

  it("ignores token deltas and refreshes only at state-changing boundaries", () => {
    expect(shouldRefreshWorkflow({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } })).toBe(false);
    expect(shouldRefreshWorkflow({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } })).toBe(false);
    expect(shouldRefreshWorkflow({ type: "tool_execution_start" })).toBe(false);
    expect(shouldRefreshWorkflow({ type: "tool_execution_end" })).toBe(true);
    expect(shouldRefreshWorkflow({ type: "agent_end" })).toBe(true);
  });

  it("deletes project workflows but refuses built-in packages", async () => {
    const removed: string[] = [];
    const source = "/project/workflows/custom-design.yaml";
    const yaml = "schema: 1\nid: custom.design\ndescription: Test\ntags: [custom]\nversion: 1.0.0\nworkflow:\n  schema: 1\n  id: custom.design\n  version: 1.0.0\n  initialPhase: done\n  phases:\n    done:\n      purpose: Done\n      actions: []\n      grants: [file_read]\n      writeScopes: []\n      recordObligations: []\n      evidenceObligations: []\n      contextProviders: [kernel.current-action]\n      hooks: []\n      transitions: {}\n      terminal: true\n";
    const bridge = {
      resolveRuntimePaths: async () => ({ projectPath: "/project", piCadRepo: "/runtime" }),
      exec: async (args: string[]) => {
        if (args[0] === "realpath" && args.at(-1) === "/project/workflows") return { stdout: "/project/workflows\n" };
        if (args[0] === "realpath") return { stdout: `${args.at(-1)}\n` };
        if (args[0] === "cat" && args[1] === source) return { stdout: yaml };
        if (args[0] === "cat") throw new Error("missing policy");
        if (args[0] === "rm") { removed.push(args[2]!); return { stdout: "" }; }
        if (args[0] === "test") return { stdout: "" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    };
    const store = new WorkflowStore(bridge as never);
    await store.delete({ projectPath: "/project" } as never, { id: "custom.design", version: "1.0.0", description: "Test", sourcePath: source, phases: [] });
    expect(removed).toEqual([source]);
    await expect(store.delete({ projectPath: "/project" } as never, { id: "mechanical.design", version: "1.0.0", description: "Built in", sourcePath: "/runtime/workflow-packages/mechanical/design.yaml", phases: [] })).rejects.toThrow("Only project workflows");
  });
});
