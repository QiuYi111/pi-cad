import { basename, join } from "node:path";
import { dialog, ipcMain } from "electron";
import type { ReleaseResult } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import type { RemoteBridge } from "../remote-bridge.js";
import { workspaceBridgeOf } from "../cloud-mode.js";
import type { MainServices } from "../services.js";

/** Moves a formal release from the workspace into the chosen local folder, file by file. */
async function downloadRelease(remote: RemoteBridge, release: ReleaseResult, localRoot: string): Promise<ReleaseResult> {
  const localPath = join(localRoot, basename(release.path));
  const files = [...release.files, { path: "release-manifest.json", sha256: "", role: "release-manifest" }];
  for (const file of files) {
    const downloaded = await remote.download(`${release.path}/${file.path}`, join(localPath, ...file.path.split("/")));
    if (file.sha256 && downloaded.sha256 !== file.sha256) throw new Error(`${file.path} did not match the approved release.`);
  }
  return { ...release, path: localPath, manifestPath: join(localPath, "release-manifest.json") };
}

/** Human approvals and formal release packaging. */
export function registerApprovalsIpc(s: MainServices) {
  ipcMain.handle(IPC.approvalsList, async () => s.approvalStore.list(await (await s.ensureViewer()).catalog(await s.settingsStore.get())));
  ipcMain.handle(IPC.approvalsApprove, async (_event, commitId: string, scope: string, rationale: string) => s.approvalStore.approve(await (await s.ensureViewer()).catalog(await s.settingsStore.get()), commitId, scope, rationale));
  ipcMain.handle(IPC.approvalsRevoke, async (_event, id: string, reason: string) => s.approvalStore.revoke(await (await s.ensureViewer()).catalog(await s.settingsStore.get()), id, reason));
  ipcMain.handle(IPC.approvalsRelease, async (_event, commitId: string, approvalId: string) => {
    const backend = await s.ensureViewer(); const settings = await s.settingsStore.get(); const catalog = await backend.catalog(settings);
    const approval = (await s.approvalStore.list(catalog)).find((item) => item.id === approvalId && item.valid);
    if (!approval) throw new Error("A current valid human approval is required for formal release.");
    const chosen = await dialog.showOpenDialog(s.mainWindow!, { title: "Choose formal release destination", properties: ["openDirectory", "createDirectory"] });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const validate = async () => Boolean((await s.approvalStore.list(await backend.catalog(settings))).find((item) => item.id === approvalId && item.valid));
    const remote = workspaceBridgeOf(await s.bridge());
    if (remote) {
      // The package is built in the workspace, then each file is downloaded to the chosen folder.
      const { projectPath } = await remote.resolveRuntimePaths(settings);
      await remote.exec(["mkdir", "-p", "--", `${projectPath}/releases`]);
      const remoteRelease = await backend.releaseCommit(settings, commitId, approval, `${projectPath}/releases`, validate);
      const localRelease = await downloadRelease(remote, remoteRelease, chosen.filePaths[0]);
      // Publishing reads the workspace copy, so the remote record is kept for it.
      s.trustedReleases.set(remoteRelease.releaseId, remoteRelease);
      return localRelease;
    }
    const release = await backend.releaseCommit(settings, commitId, approval, chosen.filePaths[0], validate);
    s.trustedReleases.set(release.releaseId, release);
    return release;
  });
  ipcMain.handle(IPC.approvalsPublishRemote, async (event, releaseId: string, remote: string, tag: string) => {
    if (!s.mainWindow || event.sender.id !== s.mainWindow.webContents.id) throw new Error("Remote publication is only available from the main Reify window.");
    const release = s.trustedReleases.get(releaseId);
    if (!release) throw new Error("Create or verify the local formal package before publishing its tag.");
    return (await s.ensureViewer()).publishRemoteRelease(await s.settingsStore.get(), release, remote, tag);
  });
}
