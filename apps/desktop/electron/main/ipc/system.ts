import { app, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import { isCloudMode, workspaceBridgeOf } from "../cloud-mode.js";
import { downloadForReveal, isWorkspacePath } from "../cloud-uploads.js";
import type { MainServices } from "../services.js";

/** System info, project settings, and the reveal-in-folder shell action. */
export function registerSystemIpc(s: MainServices) {
  ipcMain.handle(IPC.systemInstallationInfo, async () => {
    const settings = await s.settingsStore.get(); const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const channel = !app.isPackaged ? "development" : process.env.APPIMAGE ? "appimage" : platform === "windows" ? "nsis" : platform === "macos" ? "dmg" : "deb";
    const updateInstructions = channel === "deb" ? "Install the newer .deb with your package manager; keep the same project folder." : channel === "appimage" ? "Download the newer AppImage and replace the application file; project and user data remain separate." : channel === "dmg" ? "Quit active tasks, verify the signed DMG, then replace Reify in Applications." : channel === "nsis" ? "Finish or stop active tasks, then run the newer signed installer. Projects and user data are retained." : "Use the matching installation channel for updates.";
    return { version: app.getVersion(), platform, arch: process.arch, channel, packaged: app.isPackaged, userDataPath: app.getPath("userData"), projectPath: settings.projectPath, updateMode: "manual", updateInstructions, signature: app.isPackaged ? "release-signature-required" : "runtime-verified" };
  });
  ipcMain.handle(IPC.settingsGet, () => s.settingsStore.get());
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => s.settingsStore.update(patch));
  ipcMain.handle(IPC.settingsChooseProject, async () => {
    const settings = await s.settingsStore.get();
    if (isCloudMode(settings)) throw new Error("云端模式请在云端项目列表中选择项目。");
    const result = await dialog.showOpenDialog(s.mainWindow!, { title: "Choose engineering project", defaultPath: settings.projectPath || undefined, properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC.settingsCreateProject, async (_event, rawName: string) => {
    const name = rawName.trim();
    if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error("Use a valid folder name.");
    const settings = await s.settingsStore.get();
    if (isCloudMode(settings)) throw new Error("云端模式请在云端项目列表中新建项目。");
    const result = await dialog.showOpenDialog(s.mainWindow!, { title: "Choose where to create the project", defaultPath: settings.projectPath || undefined, properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = join(result.filePaths[0], name);
    await mkdir(path, { recursive: false });
    return path;
  });
  ipcMain.handle(IPC.shellReveal, async (_event, path: string) => {
    const remote = workspaceBridgeOf(await s.bridge());
    const target = remote && isWorkspacePath(path)
      ? await downloadForReveal(remote, path, s.cacheRoot())
      : await (await s.bridge()).revealPath(path);
    if (existsSync(target)) shell.showItemInFolder(target);
  });
}
