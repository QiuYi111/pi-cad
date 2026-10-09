import { app, ipcMain, shell } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { CadTransferTarget } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import { RemoteProjectIO } from "../remote-project-io.js";
import { workspaceBridgeOf } from "../cloud-mode.js";
import { downloadForReveal, isWorkspacePath } from "../cloud-uploads.js";
import { CadTransferService } from "../cad-transfer.js";
import { BridgeProjectIO, NativeProjectIO } from "../cad-transfer-project-io.js";
import { nodeFs, nodeRunner, regExeReader, systemClock } from "../cad-transfer-node.js";
import type { ProjectIO } from "../cad-transfer-paths.js";
import { AgentApiClient } from "../agent-api-client.js";
import type { MainServices } from "../services.js";
import { desktopE2E } from "../desktop-e2e.js";

/** The CAD transfer dispatcher. It is rebuilt when the runtime bridge changes. */
export async function ensureTransfer(s: MainServices): Promise<CadTransferService> {
  const current = await s.bridge();
  if (s.transfer && s.transferBridge === current) return s.transfer;
  await s.transfer?.stop();
  const appRoot = app.getAppPath();
  const resources = (...parts: string[]) => is.dev || !app.isPackaged ? join(appRoot, "../../executors", ...parts) : join(process.resourcesPath, "executors", ...parts);
  s.transfer = new CadTransferService({
    host: {
      platform: process.platform, env: process.env, home: homedir(),
      insideWsl: process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
    },
    fs: nodeFs, registry: regExeReader, runner: nodeRunner, clock: systemClock,
    bundledFusionAddin: resources("fusion", "ReifyExport"),
    bundledSolidworksExe: process.env.REIFY_SOLIDWORKS_EXECUTOR
      || (app.isPackaged ? join(process.resourcesPath, "executors", "solidworks", "ReifyExport.exe") : join(appRoot, "../../executors/solidworks/publish/ReifyExport.exe")),
    projectInWsl: current.kind === "wsl",
    pid: process.pid,
    emit: (event) => s.send(IPC.cadTransferEvent, event),
    agent: async (body, timeout) => new AgentApiClient(await s.bridge()).request(await s.settingsStore.get(), body, timeout),
  });
  s.transferBridge = current;
  return s.transfer;
}

export async function transferProject(s: MainServices): Promise<ProjectIO | null> {
  const current = await s.bridge();
  const { projectPath } = await current.resolveRuntimePaths(await s.settingsStore.get());
  if (!projectPath) return null;
  const remote = workspaceBridgeOf(current);
  if (remote) return new RemoteProjectIO(remote, projectPath, { projectId: s.cloudProjectId ?? "", cacheRoot: s.cacheRoot() });
  return current.kind === "native" ? new NativeProjectIO(projectPath) : new BridgeProjectIO(current, projectPath);
}

/** Start the spool watcher for the active project. A failure here never blocks the runtime. */
export async function startTransferDispatcher(s: MainServices) {
  if (desktopE2E) return;
  try {
    const service = await ensureTransfer(s);
    const io = await transferProject(s);
    if (io) await service.start(io);
  } catch (error) {
    s.send(IPC.runtimeEvent, { type: "runtime_diagnostic", message: `CAD transfer is off: ${String(error)}` });
  }
}

export function registerTransferIpc(s: MainServices) {
  ipcMain.handle(IPC.cadTransferStatus, async (_event, refresh?: boolean) => {
    const service = await ensureTransfer(s);
    service.setProject(await transferProject(s));
    return service.getStatus(Boolean(refresh));
  });
  ipcMain.handle(IPC.cadTransferInstallFusionAddin, async () => (await ensureTransfer(s)).installFusionAddin());
  ipcMain.handle(IPC.cadTransferOpenFolder, async (_event, target: CadTransferTarget, path?: string) => {
    const service = await ensureTransfer(s);
    const status = await service.getStatus();
    const folder = path || status.jobRoot;
    const remote = workspaceBridgeOf(await s.bridge());
    if (remote && isWorkspacePath(folder)) {
      shell.showItemInFolder(await downloadForReveal(remote, folder, s.cacheRoot()));
      return;
    }
    if (existsSync(folder)) shell.showItemInFolder(folder);
    else if (target) await shell.openPath(status.jobRoot);
  });
  ipcMain.handle(IPC.cadTransferExportPart, async (_event, target: CadTransferTarget, artifactPath: string) => {
    const service = await ensureTransfer(s);
    service.setProject(await transferProject(s));
    return service.startExport(target, artifactPath);
  });
  ipcMain.handle(IPC.cadTransferCancel, async (_event, jobId: string) => { (await ensureTransfer(s)).cancel(jobId); });
  ipcMain.handle(IPC.cadTransferTestExport, async (_event, target: CadTransferTarget) => {
    const service = await ensureTransfer(s);
    service.setProject(await transferProject(s));
    return service.testExport(target);
  });
}
