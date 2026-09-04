import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../../src/shared/contracts.js";
import { IPC } from "../../src/shared/contracts.js";

function subscribe(channel: string, listener: (value: any) => void) {
  const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    chooseProject: () => ipcRenderer.invoke(IPC.settingsChooseProject),
    createProject: (name) => ipcRenderer.invoke(IPC.settingsCreateProject, name),
  },
  runtime: {
    check: () => ipcRenderer.invoke(IPC.runtimeCheck),
    installWsl: () => ipcRenderer.invoke(IPC.runtimeInstallWsl),
    install: () => ipcRenderer.invoke(IPC.runtimeInstall),
    start: () => ipcRenderer.invoke(IPC.runtimeStart),
    stop: () => ipcRenderer.invoke(IPC.runtimeStop),
    prompt: (message, images) => ipcRenderer.invoke(IPC.runtimePrompt, message, images),
    steer: (message, images) => ipcRenderer.invoke(IPC.runtimeSteer, message, images),
    newSession: () => ipcRenderer.invoke(IPC.runtimeNewSession),
    switchSession: (path) => ipcRenderer.invoke(IPC.runtimeSwitchSession, path),
    abort: () => ipcRenderer.invoke(IPC.runtimeAbort),
    getModels: () => ipcRenderer.invoke(IPC.runtimeModels),
    setModel: (provider, model) => ipcRenderer.invoke(IPC.runtimeSetModel, provider, model),
    setThinking: (level) => ipcRenderer.invoke(IPC.runtimeSetThinking, level),
    chooseImages: () => ipcRenderer.invoke(IPC.runtimeChooseImages),
    respondToUi: (id, response) => ipcRenderer.invoke(IPC.runtimeUiResponse, id, response),
    onEvent: (listener) => subscribe(IPC.runtimeEvent, listener),
    onStatus: (listener) => subscribe(IPC.runtimeStatus, listener),
    onUiRequest: (listener) => subscribe(IPC.runtimeUiRequest, listener),
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatusGet),
    login: () => ipcRenderer.invoke(IPC.authLogin),
    submitManualCode: (value: string) => ipcRenderer.invoke(IPC.authManualCode, value),
    onStatus: (listener: (status: any) => void) => subscribe(IPC.authStatus, listener),
  },
  workflow: {
    list: () => ipcRenderer.invoke(IPC.workflowList),
    current: () => ipcRenderer.invoke(IPC.workflowCurrent),
    save: (document) => ipcRenderer.invoke(IPC.workflowSave, document),
  },
  viewer: {
    loadStep: (path) => ipcRenderer.invoke(IPC.viewerLoadStep, path),
    chooseStep: () => ipcRenderer.invoke(IPC.viewerChooseStep),
    catalog: () => ipcRenderer.invoke(IPC.viewerCatalog),
    previewParameters: (manifestPath, values) => ipcRenderer.invoke(IPC.viewerPreviewParameters, manifestPath, values),
    applyParameters: (manifestPath, values) => ipcRenderer.invoke(IPC.viewerApplyParameters, manifestPath, values),
    openParaView: (path) => ipcRenderer.invoke(IPC.viewerOpenParaView, path),
    stopParaView: () => ipcRenderer.invoke(IPC.viewerStopParaView),
    openParaViewDesktop: (path) => ipcRenderer.invoke(IPC.viewerOpenParaViewDesktop, path),
  },
  traces: {
    list: () => ipcRenderer.invoke(IPC.tracesList),
    read: (path) => ipcRenderer.invoke(IPC.tracesRead, path),
    rate: (paths, evaluation) => ipcRenderer.invoke(IPC.tracesRate, paths, evaluation),
    distill: (paths, evaluation) => ipcRenderer.invoke(IPC.tracesDistill, paths, evaluation),
    onDistillation: (listener) => subscribe(IPC.tracesDistillStatus, listener),
  },
  shell: { reveal: (path) => ipcRenderer.invoke(IPC.shellReveal, path) },
};

contextBridge.exposeInMainWorld("piCad", api);
