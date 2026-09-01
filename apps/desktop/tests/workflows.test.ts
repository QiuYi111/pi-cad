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
});
