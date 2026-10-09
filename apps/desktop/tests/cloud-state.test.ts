import { describe, expect, it } from "vitest";
import { cloudErrorMessage, dismissCloudNotice, initialCloudView, reduceCloudEvent, workspaceLabel, type CloudView } from "../src/renderer/src/lib/cloud-state";
import type { CloudStatus } from "../src/shared/contracts";

const signedIn = (workspace: CloudStatus["workspace"] = { state: "stopped" }): CloudView => ({
  ...initialCloudView,
  status: {
    signedIn: true,
    baseUrl: "https://example.test",
    user: { id: "u1", email: "a@example.com", displayName: null },
    workspace,
    eventsConnected: true,
  },
});

describe("cloud view state", () => {
  it("shows the queue position while the server is full", () => {
    const view = reduceCloudEvent(signedIn(), { type: "workspace_state", state: "queued", position: 4 });
    expect(workspaceLabel(view)).toBe("排队中（第 4 位）");
  });

  it("reports reconnecting while the bridge is down, whatever the workspace state", () => {
    const view = reduceCloudEvent(signedIn({ state: "running" }), { type: "bridge_state", state: "reconnecting" });
    expect(workspaceLabel(view)).toBe("重新连接中");
    expect(workspaceLabel(reduceCloudEvent(view, { type: "bridge_state", state: "connected" }))).toBe("运行中");
  });

  it("raises the idle warning and clears it when the user keeps working", () => {
    const warned = reduceCloudEvent(signedIn({ state: "running" }), { type: "idle_warning", reclaimAt: "2026-10-09T10:05:00Z" });
    expect(warned.idleWarning).toBe(true);
    expect(dismissCloudNotice(warned, "idle").idleWarning).toBe(false);
    // A state event that is not "running" means the workspace is no longer active, so the warning ends too.
    expect(reduceCloudEvent(warned, { type: "workspace_state", state: "running" }).idleWarning).toBe(true);
    expect(reduceCloudEvent(warned, { type: "workspace_state", state: "stopped" }).idleWarning).toBe(false);
  });

  it("marks the workspace paused and shows the reclaim notice, which can be dismissed", () => {
    const reclaimed = reduceCloudEvent(signedIn({ state: "running" }), { type: "reclaimed" });
    expect(reclaimed.reclaimed).toBe(true);
    expect(reclaimed.status?.workspace.state).toBe("stopped");
    expect(dismissCloudNotice(reclaimed, "reclaimed").reclaimed).toBe(false);
  });

  it("returns to the sign-in gate when the session ends", () => {
    const ended = reduceCloudEvent(signedIn({ state: "running" }), { type: "session_ended", reason: "expired" });
    expect(ended.status?.signedIn).toBe(false);
    expect(workspaceLabel(ended)).toBe("未登录");
  });

  it("strips the IPC wrapper from errors but keeps the server message", () => {
    const wrapped = new Error("Error invoking remote method 'cloud:login': Error: 邮箱或密码错误");
    expect(cloudErrorMessage(wrapped)).toBe("邮箱或密码错误");
    expect(cloudErrorMessage(new Error("Error: 账户已停用，请联系管理员。"))).toBe("账户已停用，请联系管理员。");
  });
});
