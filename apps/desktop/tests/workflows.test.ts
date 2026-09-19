import { describe, expect, it } from "vitest";
import { WorkflowStore } from "../electron/main/workflows";
import { shouldRefreshWorkflow } from "../src/renderer/src/components/WorkflowRail";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("desktop workflow projection", () => {
  /** A bridge that answers one Agent API request and records its body. */
  function agentApiBridge(result: unknown, requests: Array<Record<string, unknown>> = []) {
    return {
      exec: async () => ({ stdout: "/project\n", stderr: "" }),
      homeDirectory: async () => "/home/tester",
      commandPath: async () => "/usr/bin/node",
      toRuntimePath: async (path: string) => path,
      resolveRuntimePaths: async () => ({ piCadRepo: "/runtime/pi-cad", primeAgentRepo: "/runtime/prime-agent", projectPath: "/project" }),
      pipe: async (_args: string[], input: string) => {
        requests.push(JSON.parse(input) as Record<string, unknown>);
        return { stdout: `${JSON.stringify({ schema: 1, ok: true, result })}\n`, stderr: "" };
      },
    };
  }

  it("reads the workflow of the selected conversation from the authority", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const projected = {
      runId: "run-1", workflowId: "custom.branching", workflowVersion: "1.0.0", workflowHash: "abc",
      phase: "verify", status: "active", updatedAt: "now", phaseHistory: ["intake", "verify"],
      phases: [{ id: "verify", title: "Verify", purpose: "Check", status: "active", transitions: [{ event: "retry", target: "intake" }], capabilities: ["probe.run"], obligations: ["evidence"] }],
    };
    const store = new WorkflowStore(agentApiBridge(projected, requests) as never);
    const current = await store.current({ projectPath: "/project", distro: "Ubuntu" } as never, "session-a");
    expect(requests).toEqual([{ schema: 1, op: "workflow-current", sessionId: "session-a" }]);
    expect(current.workflowId).toBe("custom.branching");
    expect(current.workflowHash).toBe("abc");
    expect(current.runId).toBe("run-1");
    expect(current.updatedAt).toBe("now");
    expect(current.phases[0]?.transitions).toEqual([{ event: "retry", target: "intake" }]);
    expect(current.phases[0]?.capabilities).toEqual(["probe.run"]);
  });

  it("never projects the run another conversation left in the workspace", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const projectPath = await mkdtemp(join(tmpdir(), "pi-cad-workflow-"));
    await mkdir(join(projectPath, ".pi-cad"));
    // The workspace projection is written by whichever conversation talked to
    // the authority last; it is not authority and must not be read as state.
    await writeFile(join(projectPath, ".pi-cad", "status.json"), JSON.stringify({ run: {
      id: "run-from-another-conversation", workflowId: "custom.branching", phase: "final", status: "done", phases: [],
    } }));
    const store = new WorkflowStore(agentApiBridge(null, requests) as never);
    const current = await store.current({ projectPath, distro: "Ubuntu" } as never, "session-b");
    expect(current.runId).toBeUndefined();
    expect(current).toMatchObject({ authoritative: false, phaseHistory: [], phases: [] });
    expect(requests[0]).toMatchObject({ op: "workflow-current", sessionId: "session-b" });
  });

  it("shows a conversation with nothing selected as unbound without asking anyone", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const store = new WorkflowStore(agentApiBridge(null, requests) as never);
    await expect(store.current({ projectPath: "/project", distro: "Ubuntu" } as never)).resolves.toMatchObject({
      authoritative: false, phases: [], phaseHistory: [],
    });
    expect(requests).toEqual([]);
  });

  it("returns an explicit idle state when no project is selected", async () => {
    await expect(new WorkflowStore({} as never).current({ projectPath: "" } as never, "session-a")).resolves.toMatchObject({ phases: [], phaseHistory: [] });
  });

  it("ignores token deltas and refreshes only at state-changing boundaries", () => {
    expect(shouldRefreshWorkflow({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } })).toBe(false);
    expect(shouldRefreshWorkflow({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } })).toBe(false);
    expect(shouldRefreshWorkflow({ type: "tool_execution_start" })).toBe(false);
    expect(shouldRefreshWorkflow({ type: "tool_execution_end" })).toBe(true);
    expect(shouldRefreshWorkflow({ type: "agent_end" })).toBe(true);
  });

  it("deletes user workflows but refuses runtime modes", async () => {
    const removed: string[] = [];
    const source = "/home/tester/.pi-cad/workflows/custom-design.yaml";
    const yaml = "schema: 1\nid: custom.design\ndescription: Test\ntags: [custom]\nversion: 1.0.0\nworkflow:\n  schema: 1\n  id: custom.design\n  version: 1.0.0\n  initialPhase: done\n  phases:\n    done:\n      purpose: Done\n      actions: []\n      grants: [file_read]\n      writeScopes: []\n      recordObligations: []\n      evidenceObligations: []\n      contextProviders: [kernel.current-action]\n      hooks: []\n      transitions: {}\n      terminal: true\n";
    const bridge = {
      homeDirectory: async () => "/home/tester",
      resolveRuntimePaths: async () => ({ projectPath: "/project", piCadRepo: "/runtime" }),
      exec: async (args: string[]) => {
        if (args[0] === "realpath" && args.at(-1) === "/home/tester/.pi-cad/workflows") return { stdout: "/home/tester/.pi-cad/workflows\n" };
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
    await expect(store.delete({ projectPath: "/project" } as never, { id: "mechanical.design", version: "1.0.0", description: "Built in", sourcePath: "/runtime/workflow-packages/mechanical/design.yaml", phases: [] })).rejects.toThrow("Only user workflows");
  });
});
