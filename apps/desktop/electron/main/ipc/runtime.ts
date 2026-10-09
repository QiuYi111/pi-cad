import { app, dialog, ipcMain, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RuntimeStatus } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import { isCloudMode, workspaceBridgeOf } from "../cloud-mode.js";
import { uploadChosenImages } from "../cloud-uploads.js";
import { NO_CONVERSATION, selectNewConversation } from "../conversation-selection.js";
import type { MainServices } from "../services.js";
import { startTransferDispatcher } from "./transfer.js";
import { desktopE2E } from "../desktop-e2e.js";

const demoRuntimeStatus: RuntimeStatus = { state: "idle", checks: [
  ["wsl", "Windows Subsystem for Linux"], ["node", "Node.js 22+"], ["python", "Python"],
  ["uv", "uv"], ["bwrap", "Bubblewrap"], ["paraview", "ParaView"], ["prime", "Prime Agent"], ["picad", "Reify runtime"],
].map(([id, label]) => ({ id: id as RuntimeStatus["checks"][number]["id"], label, status: "ready", detail: "Bundled", installable: false })) };

function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true }, (error) => error ? reject(error) : resolve()));
}

async function registerSetupResume() {
  if (!app.isPackaged || process.platform !== "win32") return;
  const command = `\"${process.execPath}\" --resume-setup`;
  await execFilePromise("reg.exe", ["ADD", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", "ReifySetupResume", "/t", "REG_SZ", "/d", command, "/f"]);
}

async function setupResumeRegistered(): Promise<boolean> {
  if (!app.isPackaged || process.platform !== "win32") return false;
  return execFilePromise("reg.exe", ["QUERY", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", "ReifySetupResume"])
    .then(() => true, () => false);
}

/** Cloud mode runs commands in the workspace, so the workspace must be running before the runtime starts. */
async function ensureCloudWorkspace(s: MainServices): Promise<void> {
  const settings = await s.settingsStore.get();
  if (!isCloudMode(settings)) return;
  if (!settings.cloud?.projectId) throw new Error("请先选择云端项目。");
  const session = await s.ensureCloud(settings);
  await session.startWorkspace();
}

export function registerRuntimeIpc(s: MainServices) {
  ipcMain.handle(IPC.runtimeCheck, async () => {
    if (desktopE2E) return demoRuntimeStatus;
    if (await setupResumeRegistered()) return {
      state: "action-required", checks: [], action: "restart-windows", progress: 0.25,
      message: "Windows 已准备好 WSL。重启后 Reify 会自动继续安装。",
    } satisfies RuntimeStatus;
    return (await s.bridge()).check(await s.settingsStore.get());
  });
  ipcMain.handle(IPC.runtimeInstallWsl, async () => {
    if (desktopE2E) return demoRuntimeStatus;
    const status = await (await s.bridge()).installWsl((value) => s.send(IPC.runtimeStatus, value));
    if (status.action === "restart-windows") {
      await registerSetupResume();
      s.mainWindow?.webContents.reload();
    }
    return status;
  });
  ipcMain.handle(IPC.runtimeRestartWindows, async () => {
    if (desktopE2E) return;
    await registerSetupResume();
    await execFilePromise("shutdown.exe", ["/r", "/t", "3", "/c", "Reify 将在重启后继续准备工程环境。"]);
  });
  ipcMain.handle(IPC.runtimeInstall, async () => {
    const current = await s.settingsStore.get();
    return (await s.bridge()).install(current, (status) => s.send(IPC.runtimeStatus, status));
  });
  ipcMain.handle(IPC.runtimeCheckSimulation, async () => desktopE2E
    ? { state: "ready", component: "torch-fem-0.9", detail: "CUDA managed runtime qualified", estimatedSize: "about 6 GB" }
    : (await s.bridge()).checkSimulationComponent(await s.settingsStore.get()));
  ipcMain.handle(IPC.runtimeInstallSimulation, async () => desktopE2E
    ? { state: "ready", component: "torch-fem-0.9", detail: "CUDA managed runtime qualified", estimatedSize: "about 6 GB" }
    : (await s.bridge()).installSimulationComponent(await s.settingsStore.get()));
  ipcMain.handle(IPC.runtimeStart, async () => {
    await ensureCloudWorkspace(s);
    const started = await (await s.ensureRuntime()).start(await s.settingsStore.get());
    s.publishConversation();
    void startTransferDispatcher(s);
    return started;
  });
  ipcMain.handle(IPC.runtimeRestore, async () => s.runtime
    ? { status: s.runtime.status, messages: await s.runtime.getMessages() }
    : { status: { state: "idle", checks: [] }, messages: [] });
  ipcMain.handle(IPC.runtimeStop, async () => { await s.stopRuntime(); });
  ipcMain.handle(IPC.runtimePrompt, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await s.ensureRuntime()).prompt(message, images));
  ipcMain.handle(IPC.runtimeSteer, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await s.ensureRuntime()).steer(message, images));
  ipcMain.handle(IPC.runtimeNewConversation, async () => {
    // Selecting a new conversation is a selection, not a Prime session: the
    // projection drops to unbound immediately and Prime opens the session when
    // the conversation gets its first prompt.
    s.conversation = selectNewConversation(s.runtime?.status.sessionId);
    s.publishConversation();
    return [];
  });
  ipcMain.handle(IPC.runtimeNewSession, async () => {
    // The new conversation's own Prime session. Its run binding starts empty,
    // so the workflow projection is unbound until that conversation starts one.
    const messages = await (await s.ensureRuntime()).newSession();
    s.conversation = NO_CONVERSATION;
    s.publishConversation();
    return messages;
  });
  ipcMain.handle(IPC.runtimeSwitchSession, async (_event, path: string) => {
    const messages = await (await s.ensureRuntime()).switchSession(path, await s.settingsStore.get());
    s.conversation = NO_CONVERSATION;
    s.publishConversation();
    return messages;
  });
  ipcMain.handle(IPC.runtimeSetSessionName, async (_event, name: string) => (await s.ensureRuntime()).setSessionName(name));
  ipcMain.handle(IPC.runtimeAbort, async () => (await s.ensureRuntime()).abort());
  ipcMain.handle(IPC.runtimeModels, async () => (await s.ensureRuntime()).getModels());
  ipcMain.handle(IPC.runtimeSetModel, async (_event, provider: string, model: string) => (await s.ensureRuntime()).setModel(provider, model));
  ipcMain.handle(IPC.runtimeSetThinking, async (_event, level) => (await s.ensureRuntime()).setThinking(level));
  ipcMain.handle(IPC.runtimeChooseImages, async () => {
    const result = await dialog.showOpenDialog(s.mainWindow!, { title: "Attach reference images", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    if (result.canceled) return [];
    const settings = await s.settingsStore.get();
    const images = await Promise.all(result.filePaths.map(async (path) => {
      const data = await readFile(path);
      if (data.byteLength > 20 * 1024 * 1024) throw new Error(`Image is larger than 20 MB: ${path}`);
      const decoded = nativeImage.createFromBuffer(data);
      const size = decoded.getSize();
      if (decoded.isEmpty() || size.width < 1 || size.height < 1) throw new Error(`Image cannot be decoded: ${path}`);
      if (size.width > 16_384 || size.height > 16_384) throw new Error(`Image dimensions exceed 16384 px: ${path}`);
      const extension = extname(path).toLowerCase();
      const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
      return { name: path.split(/[\\/]/).at(-1) || "image", data: data.toString("base64"), mimeType };
    }));
    const remote = workspaceBridgeOf(await s.bridge());
    if (!remote) return images;
    // Cloud mode also keeps each image in the project, so Prime can read it by path.
    const { projectPath } = await remote.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("请先选择云端项目。");
    const uploaded = await uploadChosenImages(remote, result.filePaths, projectPath);
    return images.map((image, index) => ({ ...image, remotePath: uploaded[index]!.remotePath }));
  });
  ipcMain.handle(IPC.runtimeUiResponse, async (_event, id: string, response: Record<string, unknown>) => (await s.ensureRuntime()).respondToUi(id, response));
}
