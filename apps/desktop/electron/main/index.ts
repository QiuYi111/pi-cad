import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AppSettings, ModelParameterValue, RuntimeStatus, WorkflowDocument } from "../../src/shared/contracts.js";
import { IPC } from "../../src/shared/contracts.js";
import { SettingsStore } from "./settings-store.js";
import { WslBridge } from "./wsl.js";
import { NativeBridge } from "./native.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { PrimeRpc } from "./prime-rpc.js";
import { WorkflowStore } from "./workflows.js";
import { ViewerBackend } from "./viewer.js";
import { TraceStore } from "./traces.js";
import { DemoRuntime } from "./demo-runtime.js";
import { AuthController } from "./auth.js";
import { ParaViewBackend } from "./paraview.js";

let mainWindow: BrowserWindow | null = null;
const settingsStore = new SettingsStore();
let runtime: PrimeRpc | DemoRuntime | null = null;
let authController: AuthController | null = null;
let runtimeBridge: RuntimeBridge | null = null;
let runtimeBridgeKey = "";
let paraView: ParaViewBackend | null = null;
let paraViewBridge: RuntimeBridge | null = null;
let viewer: ViewerBackend | null = null;
let viewerBridge: RuntimeBridge | null = null;
const desktopE2E = process.env.PI_CAD_DESKTOP_E2E === "1" || process.argv.includes("--pi-cad-e2e");
const realTraceE2E = desktopE2E && process.env.PI_CAD_DESKTOP_E2E_REAL_TRACES === "1";
const authE2E = desktopE2E || process.env.PI_CAD_DESKTOP_E2E_AUTH === "1" || process.argv.includes("--pi-cad-e2e-auth");
const demoRuntimeStatus: RuntimeStatus = { state: "idle", checks: [
  ["wsl", "Windows Subsystem for Linux"], ["node", "Node.js 22+"], ["python", "Python"],
  ["uv", "uv"], ["bwrap", "Bubblewrap"], ["paraview", "ParaView"], ["prime", "Prime Agent"], ["picad", "Pi-CAD runtime"],
].map(([id, label]) => ({ id: id as RuntimeStatus["checks"][number]["id"], label, status: "ready", detail: "Bundled", installable: false })) };

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

async function bridge(): Promise<RuntimeBridge> {
  const settings = await settingsStore.get();
  const bundledRuntime = is.dev ? join(app.getAppPath(), "resources/runtime") : join(process.resourcesPath, "runtime");
  const key = process.platform === "win32" ? `wsl:${settings.distro}` : `native:${process.platform}`;
  if (!runtimeBridge || runtimeBridgeKey !== key) {
    runtimeBridge = process.platform === "win32"
      ? new WslBridge(settings.distro, bundledRuntime)
      : new NativeBridge(bundledRuntime, process.execPath);
    runtimeBridgeKey = key;
  }
  return runtimeBridge;
}

async function ensureRuntime() {
  if (runtime) return runtime;
  runtime = desktopE2E ? new DemoRuntime() : new PrimeRpc(await bridge());
  runtime.on("event", (event) => send(IPC.runtimeEvent, event));
  runtime.on("status", (status) => send(IPC.runtimeStatus, status));
  runtime.on("ui-request", (request) => send(IPC.runtimeUiRequest, request));
  runtime.on("diagnostic", (message) => send(IPC.runtimeEvent, { type: "runtime_diagnostic", message }));
  return runtime;
}

async function ensureAuth() {
  if (authController) return authController;
  authController = new AuthController(await bridge(), async () => {
    const current = runtime;
    runtime = null;
    await current?.stop();
  });
  authController.on("status", (status) => send(IPC.authStatus, status));
  return authController;
}

async function ensureParaView() {
  const current = await bridge();
  if (!paraView || paraViewBridge !== current) {
    await paraView?.stop();
    paraView = new ParaViewBackend(current);
    paraViewBridge = current;
  }
  return paraView;
}

async function ensureViewer() {
  const current = await bridge();
  if (!viewer || viewerBridge !== current) {
    viewer?.stop();
    viewer = new ViewerBackend(current);
    viewerBridge = current;
  }
  return viewer;
}

function demoMesh(path: string, values: Record<string, ModelParameterValue> = {}) {
  const width = Number(values.width ?? 40);
  const depth = Number(values.depth ?? 24);
  const height = Number(values.height ?? 12);
  const x = width / 2; const y = depth / 2; const z = height;
  return {
    source: path,
    parts: [{
      name: "Adjustable body",
      positions: [-x,-y,0, x,-y,0, x,y,0, -x,y,0, -x,-y,z, x,-y,z, x,y,z, -x,y,z],
      indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
      color: "#cbd2da",
    }],
    bounds: { min: [-x,-y,0] as [number, number, number], max: [x,y,z] as [number, number, number] },
  };
}

function registerIpc() {
  const demo = desktopE2E;
  const demoParameterValues: Record<string, ModelParameterValue> = { width: 40, depth: 24, height: 12 };
  let demoEvaluation: { quality: number; difficulty: number; feedback?: string } | undefined;
  const demoWorkflow: WorkflowDocument = { id: "mechanical.one-shot", version: "1.0.0", description: "Design a verified mechanical assembly", phases: ["grilling", "spec", "concept", "parts", "assembly", "final_review", "release"].map((id, index) => ({ id, title: id.replaceAll("_", " "), purpose: `Complete ${id}`, status: index < 2 ? "complete" : index === 2 ? "active" : "pending", transitions: [], capabilities: index === 2 ? ["image.generate", "workspace.commit"] : [], obligations: [] })), raw: "id: mechanical.one-shot\nversion: 1.0.0\nworkflow:\n  phases:\n    grilling: {}\n", sourcePath: "/runtime/workflow-packages/mechanical/one-shot.yaml" };
  ipcMain.handle(IPC.settingsGet, () => settingsStore.get());
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => settingsStore.update(patch));
  ipcMain.handle(IPC.settingsChooseProject, async () => {
    const settings = await settingsStore.get();
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Choose engineering project", defaultPath: settings.projectPath || undefined, properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC.settingsCreateProject, async (_event, rawName: string) => {
    const name = rawName.trim();
    if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error("Use a valid folder name.");
    const settings = await settingsStore.get();
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Choose where to create the project", defaultPath: settings.projectPath || undefined, properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = join(result.filePaths[0], name);
    await mkdir(path, { recursive: false });
    return path;
  });
  ipcMain.handle(IPC.runtimeCheck, async () => {
    if (desktopE2E) return demoRuntimeStatus;
    return (await bridge()).check(await settingsStore.get());
  });
  ipcMain.handle(IPC.runtimeInstallWsl, async () => {
    if (desktopE2E) return demoRuntimeStatus;
    return (await bridge()).installWsl((status) => send(IPC.runtimeStatus, status));
  });
  ipcMain.handle(IPC.runtimeInstall, async () => {
    const current = await settingsStore.get();
    return (await bridge()).install(current, (status) => send(IPC.runtimeStatus, status));
  });
  ipcMain.handle(IPC.runtimeStart, async () => (await ensureRuntime()).start(await settingsStore.get()));
  ipcMain.handle(IPC.runtimeStop, async () => { await runtime?.stop(); runtime = null; });
  ipcMain.handle(IPC.runtimePrompt, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await ensureRuntime()).prompt(message, images));
  ipcMain.handle(IPC.runtimeSteer, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await ensureRuntime()).steer(message, images));
  ipcMain.handle(IPC.runtimeNewSession, async () => (await ensureRuntime()).newSession());
  ipcMain.handle(IPC.runtimeSwitchSession, async (_event, path: string) => (await ensureRuntime()).switchSession(path));
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
  ipcMain.handle(IPC.authStatusGet, async () => authE2E ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" } : (await ensureAuth()).status(await settingsStore.get()));
  ipcMain.handle(IPC.authLogin, async () => authE2E ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" } : (await ensureAuth()).login(await settingsStore.get()));
  ipcMain.handle(IPC.authManualCode, async (_event, value: string) => (await ensureAuth()).submitManualCode(value));
  ipcMain.handle(IPC.workflowList, async () => demo ? [demoWorkflow] : new WorkflowStore(await bridge()).list(await settingsStore.get()));
  ipcMain.handle(IPC.workflowCurrent, async () => demo ? {
    workflowId: demoWorkflow.id, workflowVersion: demoWorkflow.version, workflowHash: "demo", runId: "e2e", phase: "concept", status: "active",
    phaseHistory: ["grilling", "spec", "concept"], phases: demoWorkflow.phases, authoritative: false,
  } : new WorkflowStore(await bridge()).current(await settingsStore.get()));
  ipcMain.handle(IPC.workflowSave, async (_event, document: WorkflowDocument) => demo ? document : new WorkflowStore(await bridge()).save(await settingsStore.get(), document));
  ipcMain.handle(IPC.viewerChooseStep, async () => {
    const settings = await settingsStore.get();
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Open STEP model", defaultPath: settings.projectPath || undefined, properties: ["openFile"], filters: [{ name: "STEP model", extensions: ["step", "stp"] }] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC.viewerLoadStep, async (_event, path: string) => demo ? demoMesh(path) : (await ensureViewer()).loadStep(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerCatalog, async () => demo ? {
    projectId: "desktop-e2e",
    projectHead: { updatedAt: new Date().toISOString(), artifacts: [] },
    currentRun: { id: "e2e", phase: "concept", status: "active", updatedAt: new Date().toISOString(), artifacts: [{ id: "candidate:authoritative", path: "build/part.step", sha256: "demo-step", role: "authoritative-candidate-design" }] },
    commits: [],
    simulationRuns: [{ id: "demo-simulation", recipeId: "static-check", status: "completed", outputs: [{ name: "stress", type: "field", path: "simulation/stress.vtp", unit: "MPa", sha256: "demo-field" }] }],
    parameterManifests: [{
      path: "build/part.step.parameters.json",
      sha256: "demo-parameters",
      manifest: {
        schema: 1, modelId: "demo-adjustable", source: { path: "part.py", sha256: "demo-source", entrypoint: "build" },
        output: { path: "build/part.step", sha256: "demo-step" },
        parameters: [
          { id: "width", type: "number", default: 40, value: demoParameterValues.width, min: 24, max: 80, step: 1, unit: "mm", label: "Width", group: "Envelope" },
          { id: "depth", type: "number", default: 24, value: demoParameterValues.depth, min: 12, max: 48, step: 1, unit: "mm", label: "Depth", group: "Envelope" },
          { id: "height", type: "number", default: 12, value: demoParameterValues.height, min: 4, max: 30, step: 1, unit: "mm", label: "Height", group: "Envelope" },
        ],
      },
    }],
  } : (await ensureViewer()).catalog(await settingsStore.get()));
  ipcMain.handle(IPC.viewerPreviewParameters, async (_event, path: string, values: Record<string, ModelParameterValue>) => demo
    ? demoMesh(`preview:${path}`, { ...demoParameterValues, ...values })
    : (await ensureViewer()).previewParameters(await settingsStore.get(), path, values));
  ipcMain.handle(IPC.viewerApplyParameters, async (_event, path: string, values: Record<string, ModelParameterValue>) => {
    if (demo) { Object.assign(demoParameterValues, values); return; }
    await (await ensureViewer()).applyParameters(await settingsStore.get(), path, values);
  });
  ipcMain.handle(IPC.viewerOpenParaView, async (_event, path: string) => demo ? { state: "ready", sourcePath: path, url: "pi-cad://demo-paraview" } : (await ensureParaView()).open(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerStopParaView, async () => paraView?.stop());
  ipcMain.handle(IPC.viewerOpenParaViewDesktop, async (_event, path: string) => (await ensureParaView()).openDesktop(await settingsStore.get(), path));
  ipcMain.handle(IPC.tracesList, async () => demo && !realTraceE2E ? [{ id: "demo-trace", path: "/workspace/.prime-sessions/demo.jsonl", title: "Folding stand", updatedAt: Date.now(), model: "openai-codex/gpt-5.6-sol", turns: 12, toolCalls: 4, tokens: 8420, ...(demoEvaluation ? { evaluation: demoEvaluation } : {}) }] : new TraceStore(await bridge()).list(await settingsStore.get()));
  ipcMain.handle(IPC.tracesRead, async (_event, path: string) => demo && !realTraceE2E ? [{ message: { role: "user", content: "Design a folding stand" } }, { message: { role: "assistant", content: [{ type: "text", text: "I checked the interfaces before building." }] } }, { message: { role: "toolResult", toolName: "ipython", content: "Model built" } }] : new TraceStore(await bridge()).read(await settingsStore.get(), path));
  ipcMain.handle(IPC.tracesRate, async (_event, paths: string[], evaluation: { quality: number; difficulty: number; feedback?: string }) => demo && !realTraceE2E
    ? (demoEvaluation = { ...evaluation }, { rated: paths.length, triggered: false, pendingTokens: 8_420, thresholdTokens: 250_000, message: "Rating saved." })
    : new TraceStore(await bridge()).rate(await settingsStore.get(), paths, evaluation));
  ipcMain.handle(IPC.tracesDistill, async (_event, paths: string[], evaluation: { quality: number; difficulty: number }) => {
    if (demo && !realTraceE2E) {
      const status = { state: "complete", processed: paths.length, total: paths.length, message: `Experience updated · quality ${evaluation.quality}/5` } as const;
      send(IPC.tracesDistillStatus, status);
      return status;
    }
    return new TraceStore(await bridge()).distill(await settingsStore.get(), paths, evaluation, (status) => send(IPC.tracesDistillStatus, status));
  });
  ipcMain.handle(IPC.shellReveal, async (_event, path: string) => {
    const target = await (await bridge()).revealPath(path);
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

app.on("before-quit", () => { void runtime?.stop(); void paraView?.stop(); viewer?.stop(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
