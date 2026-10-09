import type { CloudEvent, CloudStatus } from "@shared/contracts";

export type BridgeConnection = "connecting" | "connected" | "reconnecting" | "closed";

/** What the cloud UI shows: the server status plus the pushed events folded into it. */
export interface CloudView {
  status: CloudStatus | null;
  bridge: BridgeConnection;
  /** The server warned that the workspace will be paused for being idle. */
  idleWarning: boolean;
  /** The workspace was paused by the server; files are kept, Python variables are not. */
  reclaimed: boolean;
}

export const initialCloudView: CloudView = { status: null, bridge: "connecting", idleWarning: false, reclaimed: false };

export function reduceCloudEvent(view: CloudView, event: CloudEvent): CloudView {
  switch (event.type) {
    case "workspace_state": {
      if (!view.status) return view;
      const running = event.state === "running";
      return {
        ...view,
        status: {
          ...view.status,
          workspace: {
            state: event.state,
            ...(event.position !== undefined ? { position: event.position } : {}),
            ...(event.error ? { error: event.error } : {}),
          },
        },
        idleWarning: running ? view.idleWarning : false,
        reclaimed: running ? false : view.reclaimed,
      };
    }
    case "idle_warning":
      return view.status ? { ...view, idleWarning: true } : view;
    case "reclaimed":
      if (!view.status) return { ...view, idleWarning: false, reclaimed: true };
      return {
        ...view,
        status: { ...view.status, workspace: { state: "stopped" } },
        idleWarning: false,
        reclaimed: true,
      };
    case "events_connection":
      return view.status ? { ...view, status: { ...view.status, eventsConnected: event.connected } } : view;
    case "bridge_state":
      return { ...view, bridge: event.state };
    case "session_ended":
      return view.status ? { ...view, status: { ...view.status, signedIn: false, user: undefined, workspace: { state: "stopped" } } } : view;
  }
}

/** Closes a notice after the user has acted on it. */
export function dismissCloudNotice(view: CloudView, notice: "idle" | "reclaimed"): CloudView {
  return notice === "idle" ? { ...view, idleWarning: false } : { ...view, reclaimed: false };
}

/** The workspace label for the status bar and the project page. */
export function workspaceLabel(view: CloudView): string {
  if (!view.status) return "";
  if (!view.status.signedIn) return "未登录";
  if (view.bridge === "reconnecting") return "重新连接中";
  const workspace = view.status.workspace;
  switch (workspace.state) {
    case "queued":
      return `排队中（第 ${workspace.position ?? "?"} 位）`;
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "failed":
      return workspace.error ? `工作区启动失败：${workspace.error}` : "工作区启动失败";
    default:
      return "已暂停";
  }
}

/** Removes the wrappers Electron adds to errors thrown across IPC, leaving the message the server or main process gave. */
export function cloudErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}
