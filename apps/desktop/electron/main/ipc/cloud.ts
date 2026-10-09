import { ipcMain } from "electron";
import type { AppSettings } from "../../../src/shared/contracts.js";
import { DEFAULT_CLOUD_BASE_URL, IPC } from "../../../src/shared/contracts.js";
import { describeLoginError, type CloudSession } from "../cloud-session.js";
import type { MainServices } from "../services.js";

/** Changes the cloud part of the settings. The server address is kept unless the patch names one. */
async function updateCloud(s: MainServices, patch: Partial<NonNullable<AppSettings["cloud"]>>): Promise<AppSettings> {
  const current = (await s.settingsStore.get()).cloud;
  return s.settingsStore.update({ cloud: { baseUrl: current?.baseUrl || DEFAULT_CLOUD_BASE_URL, ...patch } });
}

async function cloudNow(s: MainServices): Promise<CloudSession> {
  return s.ensureCloud(await s.settingsStore.get());
}

function projectName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("请输入项目名称。");
  if (name.length > 120) throw new Error("项目名称不能超过 120 个字符。");
  return name;
}

export function registerCloudIpc(s: MainServices) {
  ipcMain.handle(IPC.cloudStatus, async () => (await cloudNow(s)).status());
  ipcMain.handle(IPC.cloudLogin, async (_event, email: string, password: string) => {
    const session = await cloudNow(s);
    const previous = (await s.settingsStore.get()).cloud;
    let user;
    try {
      user = await session.login(email.trim(), password);
    } catch (error) {
      throw new Error(describeLoginError(error));
    }
    // A different account must not inherit the previous account's project selection.
    const sameAccount = previous?.userEmail === user.email;
    if (!sameAccount) await s.stopRuntime();
    await updateCloud(s, { userEmail: user.email, projectId: sameAccount ? previous?.projectId : undefined });
    return session.status();
  });
  ipcMain.handle(IPC.cloudLogout, async () => {
    await s.stopRuntime();
    const session = await cloudNow(s);
    await session.logout();
    await updateCloud(s, { userEmail: undefined, projectId: undefined });
    s.cloudProjectId = undefined;
    return session.status();
  });
  ipcMain.handle(IPC.cloudChangePassword, async (_event, oldPassword: string, newPassword: string) => {
    try {
      await (await cloudNow(s)).changePassword(oldPassword, newPassword);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle(IPC.cloudProjectsList, async () => (await cloudNow(s)).listProjects());
  ipcMain.handle(IPC.cloudProjectCreate, async (_event, name: string) => (await cloudNow(s)).createProject(projectName(name)));
  ipcMain.handle(IPC.cloudProjectRename, async (_event, id: string, name: string) => (await cloudNow(s)).renameProject(id, projectName(name)));
  ipcMain.handle(IPC.cloudProjectDelete, async (_event, id: string) => {
    await (await cloudNow(s)).deleteProject(id);
    if ((await s.settingsStore.get()).cloud?.projectId === id) {
      await s.stopRuntime();
      s.cloudProjectId = undefined;
      await updateCloud(s, { projectId: undefined });
    }
  });
  ipcMain.handle(IPC.cloudSelectProject, async (_event, id: string | null) => {
    const before = (await s.settingsStore.get()).cloud?.projectId;
    if (before !== (id ?? undefined)) await s.stopRuntime();
    const next = await updateCloud(s, { projectId: id ?? undefined });
    s.cloudProjectId = next.cloud?.projectId;
    return next;
  });
  ipcMain.handle(IPC.cloudWorkspaceStart, async () => {
    const session = await cloudNow(s);
    await session.startWorkspace();
    return session.status();
  });
  ipcMain.handle(IPC.cloudWorkspaceStop, async () => {
    const session = await cloudNow(s);
    await session.stopWorkspace();
    return session.status();
  });
  ipcMain.handle(IPC.cloudWorkspaceKeepalive, async () => (await cloudNow(s)).keepalive());
}
