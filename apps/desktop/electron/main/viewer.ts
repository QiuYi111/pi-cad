import type { AppSettings, MeshDocument, ViewerCatalog } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

export class ViewerBackend {
  constructor(private readonly bridge: RuntimeBridge) {}

  async loadStep(settings: AppSettings, path: string): Promise<MeshDocument> {
    const { piCadRepo } = await this.bridge.resolveRuntimePaths(settings);
    const linuxPath = await this.resolveProjectPath(settings, path);
    const { stdout } = await this.bridge.exec([
      `${piCadRepo}/python/.venv/bin/python`, `${piCadRepo}/scripts/desktop-export-mesh.py`, linuxPath,
    ], { timeout: 120_000 });
    return JSON.parse(stdout) as MeshDocument;
  }

  async catalog(settings: AppSettings): Promise<ViewerCatalog> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) return { projectId: "", projectHead: { updatedAt: "", artifacts: [] }, currentRun: null, commits: [], simulationRuns: [] };
    const node = await this.bridge.commandPath("node");
    const { stdout } = await this.bridge.pipe(
      [node, `${piCadRepo}/scripts/pi-cad-agent-api.mjs`, "agent-api", projectPath],
      JSON.stringify({ schema: 1, op: "viewer-catalog" }),
      60_000,
    );
    const response = JSON.parse(stdout) as { ok: boolean; result?: ViewerCatalog; error?: { message?: string } };
    if (!response.ok || !response.result) throw new Error(response.error?.message || "Viewer catalog is unavailable.");
    return response.result;
  }

  async resolveProjectPath(settings: AppSettings, path: string): Promise<string> {
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const runtimePath = path.startsWith("/workspace/")
      ? `${projectPath}/${path.slice("/workspace/".length)}`
      : !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)
        ? `${projectPath}/${path}`
        : await this.bridge.toRuntimePath(path);
    if (projectPath && !(runtimePath === projectPath || runtimePath.startsWith(`${projectPath}/`))) {
      throw new Error("The selected artifact must remain inside the active project.");
    }
    return runtimePath;
  }
}
