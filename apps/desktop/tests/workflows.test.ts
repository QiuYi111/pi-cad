import { describe, expect, it } from "vitest";
import { WorkflowStore } from "../electron/main/workflows";

describe("desktop workflow projection", () => {
  it("uses the pinned run snapshot projected by the sidecar", async () => {
    const projected = {
      run: {
        id: "run-1", workflowId: "custom.branching", workflowHash: "abc", phase: "verify", status: "active",
        updatedAt: "now", phaseHistory: ["intake", "verify"],
        phases: [{ id: "verify", title: "Verify", purpose: "Check", status: "active", transitions: [{ event: "retry", target: "intake" }], capabilities: ["probe.run"], obligations: ["evidence"] }],
      },
    };
    const bridge = {
      resolveRuntimePaths: async () => ({ projectPath: "/project" }),
      exec: async () => ({ stdout: JSON.stringify(projected), stderr: "" }),
    };
    const current = await new WorkflowStore(bridge as never).current({} as never);
    expect(current.workflowId).toBe("custom.branching");
    expect(current.workflowHash).toBe("abc");
    expect(current.phases[0]?.transitions).toEqual([{ event: "retry", target: "intake" }]);
    expect(current.phases[0]?.capabilities).toEqual(["probe.run"]);
  });

  it("returns an explicit idle state when no project is selected", async () => {
    const bridge = { resolveRuntimePaths: async () => ({ projectPath: "" }) };
    await expect(new WorkflowStore(bridge as never).current({} as never)).resolves.toMatchObject({ phases: [], phaseHistory: [] });
  });
});
