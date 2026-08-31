import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AppSettings, RuntimeStatus, WorkflowDocument } from "../../src/shared/contracts.js";
import { IPC } from "../../src/shared/contracts.js";
import { SettingsStore } from "./settings-store.js";
import { WslBridge } from "./wsl.js";
import { PrimeRpc } from "./prime-rpc.js";
import { WorkflowStore } from "./workflows.js";
import { ViewerBackend } from "./viewer.js";
import { TraceStore } from "./traces.js";
import { DemoRuntime } from "./demo-runtime.js";
import { AuthController } from "./auth.js";

let mainWindow: BrowserWindow | null = null;
const settingsStore = new SettingsStore();
let runtime: PrimeRpc | DemoRuntime | null = null;
let authController: AuthController | null = null;
let wslBridge: WslBridge | null = null;
let wslBridgeDistro = "";

if (process.env.PI_CAD_DESKTOP_E2E === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

function send(channel: string, value: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(900, Math.min(1600, Math.floor(workArea.width * 0.94)));
  const height = Math.max(640, Math.min(1000, Math.floor(workArea.height * 0.92)));
  mainWindow = new BrowserWindow({
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
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

async function bridge() {
  const settings = await settingsStore.get();
  const bundledRuntime = is.dev ? join(app.getAppPath(), "resources/runtime") : join(process.resourcesPath, "runtime");
  if (!wslBridge || wslBridgeDistro !== settings.distro) {
    wslBridge = new WslBridge(settings.distro, bundledRuntime);
    wslBridgeDistro = settings.distro;
  }
  return wslBridge;
}

async function ensureRuntime() {
  if (runtime) return runtime;
  runtime = process.env.PI_CAD_DESKTOP_E2E === "1" ? new DemoRuntime() : new PrimeRpc(await bridge());
  runtime.on("event", (event) => send(IPC.runtimeEvent, event));
  runtime.on("status", (status) => send(IPC.runtimeStatus, status));
  runtime.on("ui-request", (request) => send(IPC.runtimeUiRequest, request));
  runtime.on("diagnostic", (message) => send(IPC.runtimeEvent, { type: "runtime_diagnostic", message }));
  return runtime;
}

async function ensureAuth() {
  if (authController) return authController;
  authController = new AuthController(await bridge());
  authController.on("status", (status) => send(IPC.authStatus, status));
  return authController;
}

function registerIpc() {
  const demo = process.env.PI_CAD_DESKTOP_E2E === "1";
  const demoWorkflow: WorkflowDocument = { id: "mechanical.one-shot", version: "1.0.0", description: "Design a verified mechanical assembly", phases: ["grilling", "spec", "concept", "parts", "assembly", "final_review", "release"].map((id, index) => ({ id, title: id.replaceAll("_", " "), purpose: `Complete ${id}`, status: index < 2 ? "complete" : index === 2 ? "active" : "pending", transitions: [], capabilities: index === 2 ? ["image.generate", "workspace.commit"] : [], obligations: [] })), raw: "id: mechanical.one-shot\nversion: 1.0.0\nworkflow:\n  phases:\n    grilling: {}\n", sourcePath: "/runtime/workflow-packages/mechanical/one-shot.yaml" };
  ipcMain.handle(IPC.settingsGet, () => settingsStore.get());
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => settingsStore.update(patch));
  ipcMain.handle(IPC.settingsChooseProject, async () => {
    const settings = await settingsStore.get();
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Choose engineering project", defaultPath: settings.projectPath || undefined, properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC.runtimeCheck, async () => {
    if (process.env.PI_CAD_DESKTOP_E2E === "1") return { state: "idle", checks: [] } satisfies RuntimeStatus;
    return (await bridge()).check(await settingsStore.get());
  });
  ipcMain.handle(IPC.runtimeInstall, async () => {
    const current = await settingsStore.get();
    return (await bridge()).install(current, (status) => send(IPC.runtimeStatus, status));
  });
  ipcMain.handle(IPC.runtimeStart, async () => (await ensureRuntime()).start(await settingsStore.get()));
  ipcMain.handle(IPC.runtimeStop, async () => { await runtime?.stop(); runtime = null; });
  ipcMain.handle(IPC.runtimePrompt, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await ensureRuntime()).prompt(message, images));
  ipcMain.handle(IPC.runtimeAbort, async () => (await ensureRuntime()).abort());
  ipcMain.handle(IPC.runtimeModels, async () => (await ensureRuntime()).getModels());
  ipcMain.handle(IPC.runtimeSetModel, async (_event, provider: string, model: string) => (await ensureRuntime()).setModel(provider, model));
  ipcMain.handle(IPC.runtimeSetThinking, async (_event, level) => (await ensureRuntime()).setThinking(level));
  ipcMain.handle(IPC.runtimeChooseImages, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Attach reference images", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(async (path) => {
      const data = await readFile(path);
      if (data.byteLength > 20 * 1024 * 1024) throw new Error(`Image is larger than 20 MB: ${path}`);
      const extension = extname(path).toLowerCase();
      const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
      return { name: path.split(/[\\/]/).at(-1) || "image", data: data.toString("base64"), mimeType };
    }));
  });
  ipcMain.handle(IPC.runtimeUiResponse, async (_event, id: string, response: Record<string, unknown>) => (await ensureRuntime()).respondToUi(id, response));
  ipcMain.handle(IPC.authStatusGet, async () => demo ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" } : (await ensureAuth()).status(await settingsStore.get()));
  ipcMain.handle(IPC.authLogin, async () => demo ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" } : (await ensureAuth()).login(await settingsStore.get()));
  ipcMain.handle(IPC.authManualCode, async (_event, value: string) => (await ensureAuth()).submitManualCode(value));
  ipcMain.handle(IPC.workflowList, async () => demo ? [demoWorkflow] : new WorkflowStore(await bridge()).list(await settingsStore.get()));
  ipcMain.handle(IPC.workflowCurrent, async () => demo ? { workflowId: demoWorkflow.id, runId: "e2e", phase: "concept", status: "active", authoritative: false } : new WorkflowStore(await bridge()).current(await settingsStore.get()));
  ipcMain.handle(IPC.workflowSave, async (_event, document: WorkflowDocument) => demo ? document : new WorkflowStore(await bridge()).save(await settingsStore.get(), document));
  ipcMain.handle(IPC.viewerChooseStep, async () => {
    const settings = await settingsStore.get();
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Open STEP model", defaultPath: settings.projectPath || undefined, properties: ["openFile"], filters: [{ name: "STEP model", extensions: ["step", "stp"] }] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC.viewerLoadStep, async (_event, path: string) => demo ? { source: path, parts: [{ name: "Demo", positions: [-1,-1,0,1,-1,0,0,1,0], indices: [0,1,2], color: "#7da8f7" }], bounds: { min: [-1,-1,0], max: [1,1,0] } } : new ViewerBackend(await bridge()).loadStep(await settingsStore.get(), path));
  ipcMain.handle(IPC.tracesList, async () => demo ? [{ id: "demo-trace", path: "/workspace/.prime-sessions/demo.jsonl", title: "Folding stand", updatedAt: Date.now(), model: "openai-codex/gpt-5.6-sol", turns: 12, toolCalls: 4, tokens: 8420 }] : new TraceStore(await bridge()).list(await settingsStore.get()));
  ipcMain.handle(IPC.tracesRead, async (_event, path: string) => demo ? [{ message: { role: "user", content: "Design a folding stand" } }, { message: { role: "assistant", content: [{ type: "text", text: "I checked the interfaces before building." }] } }, { message: { role: "toolResult", toolName: "ipython", content: "Model built" } }] : new TraceStore(await bridge()).read(await settingsStore.get(), path));
  ipcMain.handle(IPC.tracesDistill, async (_event, paths: string[], evaluation: { quality: number; difficulty: number }) => {
    if (demo) {
      const status = { state: "complete", processed: paths.length, total: paths.length, message: `Experience updated · quality ${evaluation.quality}/5` } as const;
      send(IPC.tracesDistillStatus, status);
      return status;
    }
    return new TraceStore(await bridge()).distill(await settingsStore.get(), paths, evaluation, (status) => send(IPC.tracesDistillStatus, status));
  });
  ipcMain.handle(IPC.shellReveal, async (_event, path: string) => {
    const settings = await settingsStore.get();
    const target = path.startsWith("/") ? `\\\\wsl.localhost\\${settings.distro}${path.replaceAll("/", "\\")}` : path;
    if (existsSync(target)) shell.showItemInFolder(target);
  });
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.picad.desktop");
  app.on("browser-window-created", (_event, window) => optimizer.watchWindowShortcuts(window));
  protocol.registerFileProtocol("pi-cad", (_request, callback) => callback({ error: -6 }));
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => { void runtime?.stop(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
