import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, screen, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppSettings, ModelParameterValue, ReleaseResult, RuntimeStatus, WorkflowDocument } from "../../src/shared/contracts.js";
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
import { BlenderBackend } from "./blender.js";
import { HumanApprovalStore } from "./approvals.js";

// Keep existing settings and sign-in state across the public rename, while honoring
// Electron's explicit profile override for managed deployments and isolated tests.
const hasExplicitUserData = process.argv.some((argument) => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="));
if (app.isPackaged && !hasExplicitUserData) app.setPath("userData", join(app.getPath("appData"), "Pi-CAD"));

let mainWindow: BrowserWindow | null = null;
const settingsStore = new SettingsStore();
const approvalStore = new HumanApprovalStore(join(app.getPath("userData"), "human-approvals"));
let runtime: PrimeRpc | DemoRuntime | null = null;
let authController: AuthController | null = null;
let runtimeBridge: RuntimeBridge | null = null;
let runtimeBridgeKey = "";
let paraView: ParaViewBackend | null = null;
let paraViewBridge: RuntimeBridge | null = null;
let viewer: ViewerBackend | null = null;
let viewerBridge: RuntimeBridge | null = null;
let blender: BlenderBackend | null = null;
let blenderBridge: RuntimeBridge | null = null;
const trustedReleases = new Map<string, ReleaseResult>();
const desktopE2E = process.env.PI_CAD_DESKTOP_E2E === "1" || process.argv.includes("--pi-cad-e2e");
const desktopE2EOpenStep = process.env.PI_CAD_DESKTOP_E2E_OPEN_STEP
  || process.argv.find((argument) => argument.startsWith("--pi-cad-e2e-open-step="))?.slice("--pi-cad-e2e-open-step=".length);
const testOpenSteps = process.argv
  .filter((argument) => argument.startsWith("--pi-cad-test-open-step="))
  .map((argument) => argument.slice("--pi-cad-test-open-step=".length));
const testExportStep = process.argv.find((argument) => argument.startsWith("--pi-cad-test-export-step="))?.slice("--pi-cad-test-export-step=".length);
const realTraceE2E = desktopE2E && process.env.PI_CAD_DESKTOP_E2E_REAL_TRACES === "1";
const authE2E = desktopE2E || process.env.PI_CAD_DESKTOP_E2E_AUTH === "1" || process.argv.includes("--pi-cad-e2e-auth");
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
  const rendererUrl = is.dev && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = is.dev
      ? new URL(url).origin === new URL(rendererUrl).origin
      : url === rendererUrl || url.startsWith(`${rendererUrl}#`);
    if (!allowed) event.preventDefault();
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

async function ensureBlender() {
  const current = await bridge();
  if (!blender || blenderBridge !== current) {
    blender?.stop();
    blender = new BlenderBackend(current);
    blenderBridge = current;
  }
  return blender;
}

function demoMesh(path: string, values: Record<string, ModelParameterValue> = {}) {
  const width = Number(values.width ?? 40);
  const depth = Number(values.depth ?? 24);
  const height = Number(values.height ?? 12);
  const x = width / 2; const y = depth / 2; const z = height;
  const positions = (dx: number, dy: number, scale = 1) => [-x*scale+dx,-y*scale+dy,0, x*scale+dx,-y*scale+dy,0, x*scale+dx,y*scale+dy,0, -x*scale+dx,y*scale+dy,0, -x*scale+dx,-y*scale+dy,z*scale, x*scale+dx,-y*scale+dy,z*scale, x*scale+dx,y*scale+dy,z*scale, -x*scale+dx,y*scale+dy,z*scale];
  const indices = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7];
  return {
    source: path,
    sha256: "demo-step",
    parts: [
      { id: "frame:solid-1", partId: "frame", solidId: "frame:solid-1", name: "Bracket", positions: positions(-x * .55, 0, .42), indices, color: "#cbd2da" },
      { id: "frame:solid-2", partId: "frame", solidId: "frame:solid-2", name: "Bracket", positions: positions(x * .55, 0, .42), indices, color: "#b7c0b6" },
      { id: "pin:solid-1", partId: "pin", solidId: "pin:solid-1", name: "Bracket", positions: positions(0, 0, .22), indices, color: "#8f978e" },
    ],
    bounds: { min: [-x,-y,0] as [number, number, number], max: [x,y,z] as [number, number, number] },
  };
}

function registerIpc() {
  ipcMain.handle(IPC.systemInstallationInfo, async () => {
    const settings = await settingsStore.get(); const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const channel = !app.isPackaged ? "development" : process.env.APPIMAGE ? "appimage" : platform === "windows" ? "nsis" : platform === "macos" ? "dmg" : "deb";
    const updateInstructions = channel === "deb" ? "Install the newer .deb with your package manager; keep the same project folder." : channel === "appimage" ? "Download the newer AppImage and replace the application file; project and user data remain separate." : channel === "dmg" ? "Quit active tasks, verify the signed DMG, then replace Reify in Applications." : channel === "nsis" ? "Finish or stop active tasks, then run the newer signed installer. Projects and user data are retained." : "Use the matching installation channel for updates.";
    return { version: app.getVersion(), platform, arch: process.arch, channel, packaged: app.isPackaged, userDataPath: app.getPath("userData"), projectPath: settings.projectPath, updateMode: "manual", updateInstructions, signature: app.isPackaged ? "release-signature-required" : "runtime-verified" };
  });
  const demo = desktopE2E;
  const demoParameterValues: Record<string, ModelParameterValue> = { width: 40, depth: 24, height: 12 };
  let demoEvaluation: { quality: number; difficulty: number; feedback?: string } | undefined;
  const demoWorkflow: WorkflowDocument = { id: "mechanical.default", version: "2.0.0", description: "Plan, build, and review an engineering result", editable: true, phases: ["plan", "cook", "final", "done"].map((id, index) => ({ id, title: id, purpose: `Complete ${id}`, status: index < 1 ? "complete" : index === 1 ? "active" : "pending", transitions: [], capabilities: id === "plan" ? ["codex_generate_image", "workspace.commit"] : [], obligations: [] })), raw: "id: mechanical.default\nversion: 2.0.0\nworkflow:\n  phases:\n    plan: {}\n", sourcePath: "/home/demo/.pi-cad/workflows/mechanical-default.yaml" };
  const demoNakedWorkflow: WorkflowDocument = { id: "mechanical.naked", version: "1.0.0", description: "Full tools with no prescribed workflow", phases: [{ id: "work", title: "work", purpose: "Complete the engineering task", status: "active", transitions: [], capabilities: ["cad_build_step", "cad_commit", "cad_simulate", "codex_generate_image"], obligations: [] }], raw: "", sourcePath: "/runtime/workflow-packages/mechanical/naked.yaml" };
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
    if (await setupResumeRegistered()) return {
      state: "action-required", checks: [], action: "restart-windows", progress: 0.25,
      message: "Windows 已准备好 WSL。重启后 Reify 会自动继续安装。",
    } satisfies RuntimeStatus;
    return (await bridge()).check(await settingsStore.get());
  });
  ipcMain.handle(IPC.runtimeInstallWsl, async () => {
    if (desktopE2E) return demoRuntimeStatus;
    const status = await (await bridge()).installWsl((value) => send(IPC.runtimeStatus, value));
    if (status.action === "restart-windows") {
      await registerSetupResume();
      mainWindow?.webContents.reload();
    }
    return status;
  });
  ipcMain.handle(IPC.runtimeRestartWindows, async () => {
    if (desktopE2E) return;
    await registerSetupResume();
    await execFilePromise("shutdown.exe", ["/r", "/t", "3", "/c", "Reify 将在重启后继续准备工程环境。"]);
  });
  ipcMain.handle(IPC.runtimeInstall, async () => {
    const current = await settingsStore.get();
    return (await bridge()).install(current, (status) => send(IPC.runtimeStatus, status));
  });
  ipcMain.handle(IPC.runtimeCheckSimulation, async () => desktopE2E
    ? { state: "ready", component: "torch-fem-0.9", detail: "CUDA managed runtime qualified", estimatedSize: "about 6 GB" }
    : (await bridge()).checkSimulationComponent(await settingsStore.get()));
  ipcMain.handle(IPC.runtimeInstallSimulation, async () => desktopE2E
    ? { state: "ready", component: "torch-fem-0.9", detail: "CUDA managed runtime qualified", estimatedSize: "about 6 GB" }
    : (await bridge()).installSimulationComponent(await settingsStore.get()));
  ipcMain.handle(IPC.runtimeStart, async () => (await ensureRuntime()).start(await settingsStore.get()));
  ipcMain.handle(IPC.runtimeRestore, async () => runtime
    ? { status: runtime.status, messages: await runtime.getMessages() }
    : { status: { state: "idle", checks: [] }, messages: [] });
  ipcMain.handle(IPC.runtimeStop, async () => { await runtime?.stop(); runtime = null; });
  ipcMain.handle(IPC.runtimePrompt, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await ensureRuntime()).prompt(message, images));
  ipcMain.handle(IPC.runtimeSteer, async (_event, message: string, images?: Array<{ data: string; mimeType: string }>) => (await ensureRuntime()).steer(message, images));
  ipcMain.handle(IPC.runtimeNewSession, async () => (await ensureRuntime()).newSession());
  ipcMain.handle(IPC.runtimeSwitchSession, async (_event, path: string) => (await ensureRuntime()).switchSession(path, await settingsStore.get()));
  ipcMain.handle(IPC.runtimeSetSessionName, async (_event, name: string) => (await ensureRuntime()).setSessionName(name));
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
      const decoded = nativeImage.createFromBuffer(data);
      const size = decoded.getSize();
      if (decoded.isEmpty() || size.width < 1 || size.height < 1) throw new Error(`Image cannot be decoded: ${path}`);
      if (size.width > 16_384 || size.height > 16_384) throw new Error(`Image dimensions exceed 16384 px: ${path}`);
      const extension = extname(path).toLowerCase();
      const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
      return { name: path.split(/[\\/]/).at(-1) || "image", data: data.toString("base64"), mimeType };
    }));
  });
  ipcMain.handle(IPC.runtimeUiResponse, async (_event, id: string, response: Record<string, unknown>) => (await ensureRuntime()).respondToUi(id, response));
  ipcMain.handle(IPC.authStatusGet, async () => authE2E ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" } : (await ensureAuth()).status(await settingsStore.get()));
  ipcMain.handle(IPC.authLogin, async () => authE2E ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" } : (await ensureAuth()).login(await settingsStore.get()));
  ipcMain.handle(IPC.authManualCode, async (_event, value: string) => (await ensureAuth()).submitManualCode(value));
  ipcMain.handle(IPC.authCancel, async () => (await ensureAuth()).cancel());
  ipcMain.handle(IPC.authSignOut, async () => (await ensureAuth()).signOut(await settingsStore.get()));
  ipcMain.handle(IPC.workflowList, async () => demo ? [demoWorkflow, demoNakedWorkflow] : new WorkflowStore(await bridge()).list(await settingsStore.get()));
  ipcMain.handle(IPC.workflowCurrent, async () => demo ? {
    workflowId: demoWorkflow.id, workflowVersion: demoWorkflow.version, workflowHash: "demo", runId: "e2e", phase: "concept", status: "active",
    phaseHistory: ["grilling", "spec", "concept"], phases: demoWorkflow.phases, authoritative: false,
  } : new WorkflowStore(await bridge()).current(await settingsStore.get()));
  ipcMain.handle(IPC.workflowSave, async (_event, document: WorkflowDocument) => demo ? document : new WorkflowStore(await bridge()).save(await settingsStore.get(), document));
  ipcMain.handle(IPC.workflowDelete, async (_event, document: WorkflowDocument) => demo ? undefined : new WorkflowStore(await bridge()).delete(await settingsStore.get(), document));
  ipcMain.handle(IPC.workflowAdoptionPolicy, async () => new WorkflowStore(await bridge()).adoptionPolicy(await settingsStore.get()));
  ipcMain.handle(IPC.workflowAdopt, async (_event, id: string, version: string) => new WorkflowStore(await bridge()).adopt(await settingsStore.get(), id, version));
  ipcMain.handle(IPC.viewerChooseStep, async () => {
    if (testOpenSteps.length) return testOpenSteps.shift()!;
    if (desktopE2E && desktopE2EOpenStep) return desktopE2EOpenStep;
    const settings = await settingsStore.get();
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Open STEP model", defaultPath: settings.projectPath || undefined, properties: ["openFile"], filters: [{ name: "STEP model", extensions: ["step", "stp"] }] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC.viewerLoadStep, async (_event, path: string) => demo ? demoMesh(path) : (await ensureViewer()).loadStep(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerExportStep, async (_event, source: string) => {
    const settings = await settingsStore.get();
    const basename = source.split(/[\\/]/).at(-1) || "model.step";
    if (testExportStep) {
      if (!demo) await (await ensureViewer()).exportStep(settings, source, testExportStep);
      return testExportStep;
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Export STEP model",
      defaultPath: basename,
      filters: [{ name: "STEP model", extensions: ["step", "stp"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (!demo) await (await ensureViewer()).exportStep(settings, source, result.filePath);
    return result.filePath;
  });
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
          { id: "fillet_radius", type: "number", default: 1, value: demoParameterValues.fillet_radius ?? 1, min: 0, max: 20, step: 0.5, unit: "mm", label: "Fillet radius", group: "Features" },
        ],
      },
    }],
  } : (await ensureViewer()).catalog(await settingsStore.get()));
  ipcMain.handle(IPC.viewerPreviewParameters, async (_event, path: string, values: Record<string, ModelParameterValue>) => {
    if (!demo) return (await ensureViewer()).previewParameters(await settingsStore.get(), path, values);
    if (Number(values.fillet_radius ?? 1) > 6) throw new Error("Fillet radius is too large for the selected body near the outer edge.");
    return demoMesh(`preview:${path}`, { ...demoParameterValues, ...values });
  });
  ipcMain.handle(IPC.viewerApplyParameters, async (_event, path: string, values: Record<string, ModelParameterValue>) => {
    if (demo) { Object.assign(demoParameterValues, values); return; }
    await (await ensureViewer()).applyParameters(await settingsStore.get(), path, values);
  });
  ipcMain.handle(IPC.viewerInspectGeometry, async (_event, path: string) => demo
    ? { source: path, sha256: "demo-step", units: "mm", bbox: { x: 40, y: 24, z: 12 }, solidCount: 3 }
    : (await ensureViewer()).inspectGeometry(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerInspectSection, async (_event, path: string, axis: "x" | "y" | "z") => demo
    ? { source: path, sha256: "demo-step", axis, position: axis === "x" ? 20 : axis === "y" ? 12 : 6, totalArea: axis === "z" ? 960 : axis === "y" ? 480 : 288, faceCount: 1, units: "mm" }
    : (await ensureViewer()).inspectSection(await settingsStore.get(), path, axis));
  ipcMain.handle(IPC.viewerOpenParaView, async (_event, path: string) => demo ? { state: "ready", sourcePath: path, url: "pi-cad://demo-paraview" } : (await ensureParaView()).open(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerInspectSimulation, async (_event, path: string) => demo
    ? { format: "VTK XML UnstructuredGrid (.vtu, ASCII)", source: path, pointCount: 842, cellCount: 1260, bounds: { x: [-20, 20], y: [-12, 12], z: [0, 12] }, fields: [{ name: "von Mises stress", association: "point", components: 1, min: 2.4, max: 82, unit: "MPa" }, { name: "displacement", association: "point", components: 3, min: 0, max: 0.34, unit: "mm" }], modelSource: "build/part.step#demo-step" }
    : (await ensureParaView()).inspect(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerStopParaView, async () => paraView?.stop());
  ipcMain.handle(IPC.viewerOpenParaViewDesktop, async (_event, path: string) => (await ensureParaView()).openDesktop(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerInspectBlender, async (_event, path: string) => demo
    ? { source: path, scene: "product.blend", cameras: ["Hero", "Detail"], activeCamera: "Hero", objectCount: 8, frame: 1, frameStart: 1, frameEnd: 120 }
    : (await ensureBlender()).inspect(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerInstallBlender, async () => demo ? undefined : (await ensureBlender()).install(await settingsStore.get()));
  ipcMain.handle(IPC.viewerRenderBlender, async (_event, path: string, camera?: string) => demo
    ? { path: ".pi-cad/renders/product.png", camera: camera || "Hero", dataUrl: "" }
    : (await ensureBlender()).render(await settingsStore.get(), path, camera));
  ipcMain.handle(IPC.viewerOpenBlenderDesktop, async (_event, path: string) => demo ? undefined : (await ensureBlender()).openDesktop(await settingsStore.get(), path));
  ipcMain.handle(IPC.viewerStopBlender, async () => blender?.stop());
  ipcMain.handle(IPC.viewerRebuildCommit, async (_event, commitId: string, manifestPath: string) => (await ensureViewer()).rebuildCommit(await settingsStore.get(), commitId, manifestPath));
  ipcMain.handle(IPC.viewerReadEvidence, async (_event, path: string) => (await ensureViewer()).readEvidence(await settingsStore.get(), path));
  ipcMain.handle(IPC.approvalsList, async () => approvalStore.list(await (await ensureViewer()).catalog(await settingsStore.get())));
  ipcMain.handle(IPC.approvalsApprove, async (_event, commitId: string, scope: string, rationale: string) => approvalStore.approve(await (await ensureViewer()).catalog(await settingsStore.get()), commitId, scope, rationale));
  ipcMain.handle(IPC.approvalsRevoke, async (_event, id: string, reason: string) => approvalStore.revoke(await (await ensureViewer()).catalog(await settingsStore.get()), id, reason));
  ipcMain.handle(IPC.approvalsRelease, async (_event, commitId: string, approvalId: string) => {
    const backend = await ensureViewer(); const settings = await settingsStore.get(); const catalog = await backend.catalog(settings);
    const approval = (await approvalStore.list(catalog)).find((item) => item.id === approvalId && item.valid);
    if (!approval) throw new Error("A current valid human approval is required for formal release.");
    const chosen = await dialog.showOpenDialog(mainWindow!, { title: "Choose formal release destination", properties: ["openDirectory", "createDirectory"] });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const validate = async () => Boolean((await approvalStore.list(await backend.catalog(settings))).find((item) => item.id === approvalId && item.valid));
    const release = await backend.releaseCommit(settings, commitId, approval, chosen.filePaths[0], validate);
    trustedReleases.set(release.releaseId, release);
    return release;
  });
  ipcMain.handle(IPC.approvalsPublishRemote, async (event, releaseId: string, remote: string, tag: string) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Remote publication is only available from the main Reify window.");
    const release = trustedReleases.get(releaseId);
    if (!release) throw new Error("Create or verify the local formal package before publishing its tag.");
    return (await ensureViewer()).publishRemoteRelease(await settingsStore.get(), release, remote, tag);
  });
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
  ipcMain.handle(IPC.tracesValidateCandidate, async (_event, jobPath: string) => new TraceStore(await bridge()).candidateAction(await settingsStore.get(), jobPath, "validate"));
  ipcMain.handle(IPC.tracesAdoptCandidate, async (_event, jobPath: string) => new TraceStore(await bridge()).candidateAction(await settingsStore.get(), jobPath, "adopt"));
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
