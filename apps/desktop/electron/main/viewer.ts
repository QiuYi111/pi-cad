import type { AppSettings, MeshDocument } from "../../src/shared/contracts.js";
import { WslBridge } from "./wsl.js";

export class ViewerBackend {
  constructor(private readonly bridge: WslBridge) {}

  async loadStep(settings: AppSettings, path: string): Promise<MeshDocument> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const linuxPath = await this.bridge.toLinuxPath(path);
    if (projectPath && !(linuxPath === projectPath || linuxPath.startsWith(`${projectPath}/`))) {
      throw new Error("The selected STEP file must remain inside the active project.");
    }
    const { stdout } = await this.bridge.exec([
      await this.bridge.commandPath("uv"), "run", "--project", `${piCadRepo}/python`, "python", `${piCadRepo}/scripts/desktop-export-mesh.py`, linuxPath,
    ], { timeout: 120_000 });
    return JSON.parse(stdout) as MeshDocument;
  }
}
