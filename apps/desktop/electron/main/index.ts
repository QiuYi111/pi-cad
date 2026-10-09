import { app, BrowserWindow, protocol, screen, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC } from "../../src/shared/contracts.js";
import { MainServices } from "./services.js";
import { registerSystemIpc } from "./ipc/system.js";
import { registerRuntimeIpc } from "./ipc/runtime.js";
import { registerAuthIpc } from "./ipc/auth.js";
import { registerWorkflowIpc } from "./ipc/workflow.js";
import { registerViewerIpc } from "./ipc/viewer.js";
import { registerApprovalsIpc } from "./ipc/approvals.js";
import { registerTracesIpc } from "./ipc/traces.js";
import { registerTransferIpc } from "./ipc/transfer.js";
import { registerCloudIpc } from "./ipc/cloud.js";

// Keep existing settings and sign-in state across the public rename, while honoring
// Electron's explicit profile override for managed deployments and isolated tests.
const hasExplicitUserData = process.argv.some((argument) => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="));
if (app.isPackaged && !hasExplicitUserData) app.setPath("userData", join(app.getPath("appData"), "Pi-CAD"));

// Created after the userData path is settled, so every store and cache resolves under it.
const services = new MainServices(app.getPath("userData"));


// Window and app lifecycle only. Each domain's IPC lives in ./ipc/.
function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(900, Math.min(1600, Math.floor(workArea.width * 0.94)));
  const height = Math.max(640, Math.min(1000, Math.floor(workArea.height * 0.92)));
  services.mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#090a0b",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  services.mainWindow.once("ready-to-show", () => services.mainWindow?.show());
  services.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const rendererUrl = is.dev && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  services.mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = is.dev
      ? new URL(url).origin === new URL(rendererUrl).origin
      : url === rendererUrl || url.startsWith(`${rendererUrl}#`);
    if (!allowed) event.preventDefault();
  });
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void services.mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void services.mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.picad.desktop");
  app.on("browser-window-created", (_event, window) => optimizer.watchWindowShortcuts(window));
  protocol.registerFileProtocol("pi-cad", (_request, callback) => callback({ error: -6 }));
  registerSystemIpc(services);
  registerRuntimeIpc(services);
  registerAuthIpc(services);
  registerWorkflowIpc(services);
  registerViewerIpc(services);
  registerApprovalsIpc(services);
  registerTracesIpc(services);
  registerTransferIpc(services);
  registerCloudIpc(services);
  createWindow();
  services.managedRuntimeBootstrap = services.syncManagedRuntime().catch((error) => {
    services.send(IPC.runtimeEvent, { type: "runtime_diagnostic", message: `Managed runtime update failed: ${String(error)}` });
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => { void services.transfer?.stop(); void services.runtime?.stop(); void services.paraView?.stop(); services.viewer?.stop(); services.cloud?.ready.then((session) => session.close(), () => undefined); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
