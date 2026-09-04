import type {
  AppSettings,
  MeshDocument,
  StoredModelParameterManifest,
  ViewerCatalog,
} from "../../src/shared/contracts.js";
import { parameterDefinitionsWithValues, validateParameterValues } from "../../src/shared/model-parameters.js";
import { withCanonicalProjectEnvironment, type RuntimeBridge } from "./runtime-bridge.js";
import { DesktopCadctlRpc } from "./cadctl-rpc.js";

interface CadctlEnvelope {
  ok: boolean;
  payload?: unknown;
}

interface AgentApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string };
}

interface WorkflowView {
  status: string;
  operations?: Array<{ capability?: string }>;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export class ViewerBackend {
  private readonly cadctl: DesktopCadctlRpc;
  private warmKey = "";
  private warmTask: Promise<void> | null = null;

  constructor(private readonly bridge: RuntimeBridge) {
    this.cadctl = new DesktopCadctlRpc(bridge);
  }

  stop(): void {
    this.cadctl.stop();
  }

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
    if (!projectPath) return { projectId: "", projectHead: { updatedAt: "", artifacts: [] }, currentRun: null, commits: [], simulationRuns: [], parameterManifests: [] };
    const node = await this.bridge.commandPath("node");
    const { stdout } = await this.bridge.pipe(
      await withCanonicalProjectEnvironment(this.bridge, projectPath, [node, `${piCadRepo}/scripts/pi-cad-agent-api.mjs`, "agent-api", projectPath]),
      JSON.stringify({ schema: 1, op: "viewer-catalog" }),
      60_000,
    );
    const response = JSON.parse(stdout) as { ok: boolean; result?: ViewerCatalog; error?: { message?: string } };
    if (!response.ok || !response.result) throw new Error(response.error?.message || "Viewer catalog is unavailable.");
    const result = { ...response.result, parameterManifests: response.result.parameterManifests ?? [] };
    if (result.parameterManifests.length) void this.prewarm(settings).catch(() => {});
    return result;
  }

  async previewParameters(
    settings: AppSettings,
    manifestPath: string,
    updates: Record<string, unknown>,
  ): Promise<MeshDocument> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before previewing parameters.");
    const stored = await this.findManifest(settings, manifestPath);
    const values = validateParameterValues(stored.manifest.parameters, updates);
    const python = `${piCadRepo}/python/.venv/bin/python`;
    const source = await this.resolveProjectPath(settings, stored.manifest.source.path);
    const preview = `/tmp/pi-cad-desktop-preview-${process.pid}/${stored.manifest.modelId}.step`;
    const built = await this.cadctl.run(python, [
      "build", "--source", source, "--output", preview,
      "--parameters-json", JSON.stringify(values), "--force",
    ], projectPath, 120_000);
    this.parseEnvelope(built, "Parameter preview build");
    const meshed = await this.cadctl.run(python, ["mesh", "--artifact", preview], projectPath, 120_000);
    const envelope = this.parseEnvelope(meshed, "Parameter preview mesh");
    const mesh = envelope.payload as MeshDocument | undefined;
    if (!mesh || !Array.isArray(mesh.parts) || !mesh.bounds) {
      throw new Error("Parameter preview returned an invalid mesh.");
    }
    return mesh;
  }

  async applyParameters(
    settings: AppSettings,
    manifestPath: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before applying parameters.");
    const stored = await this.findManifest(settings, manifestPath);
    const definitions = parameterDefinitionsWithValues(stored.manifest.parameters, updates);
    const request = async <T>(body: Record<string, unknown>, timeout = 60_000): Promise<T> => {
      const node = await this.bridge.commandPath("node");
      const { stdout } = await this.bridge.pipe(
        await withCanonicalProjectEnvironment(this.bridge, projectPath, [node, `${piCadRepo}/scripts/pi-cad-agent-api.mjs`, "agent-api", projectPath]),
        JSON.stringify({ schema: 1, ...body }),
        timeout,
      );
      const response = JSON.parse(stdout) as AgentApiEnvelope<T>;
      if (!response.ok) throw new Error(response.error?.message || "Pi-CAD rejected the parameter update.");
      return response.result as T;
    };

    let current = await request<WorkflowView | null>({ op: "workflow-current" });
    const replaceable = !current || !["active", "ready"].includes(current.status);
    if (replaceable) {
      current = await request<WorkflowView>({
        op: "workflow-start",
        id: "mechanical.parameter-edit",
        interactionMode: "headless",
      });
    }
    if (!current?.operations?.some((operation) => operation.capability === "cad_build_step")) {
      throw new Error("Finish the current workflow phase before changing model parameters.");
    }

    await request({
      op: "model-build",
      source: stored.manifest.source.path,
      output: stored.manifest.output.path,
      force: true,
      parameters: definitions,
    }, 180_000);
    if (replaceable) await request({ op: "workflow-advance", event: "applied" });
  }

  private async prewarm(settings: AppSettings): Promise<void> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) return;
    const python = `${piCadRepo}/python/.venv/bin/python`;
    const key = `${python}\0${projectPath}`;
    if (this.warmKey === key && this.warmTask) return this.warmTask;
    this.warmKey = key;
    const task = this.cadctl.run(python, ["capability"], projectPath, 120_000).then((result) => {
      this.parseEnvelope(result, "CAD preview preheat");
    });
    this.warmTask = task.catch((error) => {
      if (this.warmKey === key) {
        this.warmTask = null;
        this.warmKey = "";
      }
      throw error;
    });
    return this.warmTask;
  }

  private async findManifest(settings: AppSettings, path: string): Promise<StoredModelParameterManifest> {
    const catalog = await this.catalog(settings);
    const wanted = normalizePath(path);
    const stored = catalog.parameterManifests.find((candidate) => normalizePath(candidate.path) === wanted);
    if (!stored) throw new Error("The parameter manifest is stale or is not authorized for this project.");
    return stored;
  }

  private parseEnvelope(result: { exitCode: number; stdout: string; stderr: string }, label: string): CadctlEnvelope {
    if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr || `exit ${result.exitCode}`}`);
    let envelope: CadctlEnvelope;
    try {
      envelope = JSON.parse(result.stdout) as CadctlEnvelope;
    } catch {
      throw new Error(`${label} returned invalid JSON.`);
    }
    if (!envelope.ok) {
      const payload = envelope.payload as { error?: string } | undefined;
      throw new Error(payload?.error || `${label} failed.`);
    }
    return envelope;
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
