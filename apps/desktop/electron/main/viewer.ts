import type {
  AppSettings,
  MeshDocument,
  StoredModelParameterManifest,
  ViewerCatalog,
  QuickGeometryCheck,
  QuickSectionCheck,
  SourceRebuildResult,
  HumanApproval,
  ReleaseResult,
  RemotePublishResult,
} from "../../src/shared/contracts.js";
import { createHash } from "node:crypto";
import { parameterDefinitionsWithValues, validateParameterValues } from "../../src/shared/model-parameters.js";
import { withCanonicalProjectEnvironment, type RuntimeBridge } from "./runtime-bridge.js";
import { DesktopCadctlRpc } from "./cadctl-rpc.js";

interface CadctlEnvelope {
  ok: boolean;
  payload?: unknown;
  inputHashes?: Record<string, string>;
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

function createReleaseId(projectId: string, commitId: string, approvalId: string, artifacts: Array<{ path: string; sha256: string; role: string }>): string {
  return createHash("sha256").update(JSON.stringify({ projectId, commitId, approvalId, artifacts })).digest("hex");
}

async function hashRuntimeFile(bridge: RuntimeBridge, path: string): Promise<string> {
  return (await bridge.exec(["sha256sum", "--", path])).stdout.split(/\s+/)[0]!;
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

  async exportStep(settings: AppSettings, source: string, destination: string): Promise<void> {
    const sourcePath = await this.resolveProjectPath(settings, source);
    const destinationPath = await this.bridge.toRuntimePath(destination);
    if (normalizePath(sourcePath) === normalizePath(destinationPath)) return;
    await this.bridge.exec(["cp", "--", sourcePath, destinationPath], { timeout: 120_000 });
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
      if (!response.ok) throw new Error(response.error?.message || "Reify rejected the parameter update.");
      return response.result as T;
    };

    let current = await request<WorkflowView | null>({ op: "workflow-current" });
    const replaceable = !current || !["active", "ready"].includes(current.status);
    if (replaceable) {
      current = await request<WorkflowView>({
        op: "workflow-start",
        id: "mechanical.naked",
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
  }

  async inspectGeometry(settings: AppSettings, path: string): Promise<QuickGeometryCheck> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const source = await this.resolveProjectPath(settings, path);
    const result = await this.cadctl.run(`${piCadRepo}/python/.venv/bin/python`, ["inspect", "--artifact", source], projectPath, 120_000);
    const envelope = this.parseEnvelope(result, "Geometry inspection");
    const payload = envelope.payload as any;
    return { source, sha256: envelope.inputHashes?.artifact || "", units: payload.units || "mm", bbox: payload.bbox, solidCount: payload.solidCount };
  }

  async inspectSection(settings: AppSettings, path: string, axis: "x" | "y" | "z"): Promise<QuickSectionCheck> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const source = await this.resolveProjectPath(settings, path);
    const result = await this.cadctl.run(`${piCadRepo}/python/.venv/bin/python`, ["scan-sections", "--artifact", source, "--axis", axis, "--count", "3"], projectPath, 120_000);
    const envelope = this.parseEnvelope(result, "Section inspection");
    const payload = envelope.payload as any;
    const section = payload.sections?.[1] || payload.sections?.[0];
    if (!section) throw new Error("Section inspection returned no section facts.");
    return { source, sha256: envelope.inputHashes?.artifact || "", axis, position: section.position, totalArea: section.totalArea, faceCount: section.faceCount, units: "mm" };
  }

  async rebuildCommit(settings: AppSettings, commitId: string, manifestPath: string): Promise<SourceRebuildResult> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before rebuilding a version.");
    const catalog = await this.catalog(settings);
    const commit = catalog.commits.find((item) => item.id === commitId);
    if (!commit) throw new Error(`Preserved version not found: ${commitId}`);
    if (!commit.sourceRevision) throw new Error(`Version ${commit.name} has no recorded Git source revision.`);
    const stored = catalog.parameterManifests.find((item) => normalizePath(item.path) === normalizePath(manifestPath));
    if (!stored) throw new Error(`Version ${commit.name} has no preserved parameter manifest; source, parameters, or input dependencies are incomplete.`);
    const expected = commit.artifacts.find((artifact) => normalizePath(artifact.path) === normalizePath(stored.manifest.output.path));
    if (!expected) throw new Error(`Version ${commit.name} does not bind the parameterized output ${stored.manifest.output.path}.`);
    const isolated = `/tmp/reify-source-rebuild-${process.pid}-${Date.now()}`;
    const output = `${projectPath}/.pi-cad/rebuilds/${commit.id}.step`;
    const python = `${piCadRepo}/python/.venv/bin/python`;
    const values = Object.fromEntries(stored.manifest.parameters.map((parameter) => [parameter.id, parameter.value]));
    let worktreeAdded = false;
    try {
      await this.bridge.exec(["git", "-C", projectPath, "worktree", "add", "--detach", isolated, commit.sourceRevision], { timeout: 120_000 });
      worktreeAdded = true;
      const source = `${isolated}/${normalizePath(stored.manifest.source.path)}`;
      const sourceCheck = await this.bridge.exec(["test", "-f", source]).then(() => true).catch(() => false);
      if (!sourceCheck) throw new Error(`Rebuild input is missing at source revision ${commit.sourceRevision}: ${stored.manifest.source.path}`);
      const built = await this.bridge.exec(["env", "-C", isolated, `${piCadRepo}/python/.venv/bin/cadctl`, "build", "--source", source, "--output", output, "--parameters-json", JSON.stringify(values), "--force"], { timeout: 180_000 });
      const envelope = this.parseEnvelope({ exitCode: 0, ...built }, "Isolated source rebuild");
      const actualSha256 = envelope.inputHashes?.output || (await this.bridge.exec(["sha256sum", "--", output])).stdout.split(/\s+/)[0]!;
      let geometryMatch: boolean | null = null;
      let geometryDetail = "Original artifact is unavailable; only the recorded byte hash can be compared.";
      try {
        const original = await this.resolveProjectPath(settings, expected.path);
        const originalGeometry = await this.inspectGeometry(settings, original);
        const rebuiltGeometry = await this.inspectGeometry(settings, output);
        const axes = ["x", "y", "z"] as const;
        geometryMatch = axes.every((axis) => Math.abs(originalGeometry.bbox[axis] - rebuiltGeometry.bbox[axis]) <= 1e-6) && originalGeometry.solidCount === rebuiltGeometry.solidCount;
        geometryDetail = geometryMatch ? "Bounding box and solid count match." : `Geometry differs: expected ${JSON.stringify(originalGeometry.bbox)}/${originalGeometry.solidCount} solids, rebuilt ${JSON.stringify(rebuiltGeometry.bbox)}/${rebuiltGeometry.solidCount} solids.`;
      } catch { /* A missing or replaced historical artifact cannot support a geometry claim. */ }
      const [pythonVersion, gitVersion, platform] = await Promise.all([
        this.bridge.exec([python, "--version"]), this.bridge.exec(["git", "--version"]), this.bridge.exec(["uname", "-a"]),
      ]);
      return { commitId, sourceRevision: commit.sourceRevision, source: stored.manifest.source.path, output, expectedSha256: expected.sha256, actualSha256, byteMatch: actualSha256 === expected.sha256, geometryMatch, geometryDetail, environment: { python: (pythonVersion.stdout || pythonVersion.stderr).trim(), git: gitVersion.stdout.trim(), platform: platform.stdout.trim() }, parameters: values };
    } finally {
      if (worktreeAdded) await this.bridge.exec(["git", "-C", projectPath, "worktree", "remove", "--force", isolated], { timeout: 120_000 }).catch(() => {});
    }
  }

  async readEvidence(settings: AppSettings, path: string): Promise<unknown> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before opening evidence.");
    const node = await this.bridge.commandPath("node");
    const { stdout } = await this.bridge.pipe(await withCanonicalProjectEnvironment(this.bridge, projectPath, [node, `${piCadRepo}/scripts/pi-cad-agent-api.mjs`, "agent-api", projectPath]), JSON.stringify({ schema: 1, op: "evidence-read", path }), 60_000);
    const response = JSON.parse(stdout) as AgentApiEnvelope<unknown>;
    if (!response.ok) throw new Error(response.error?.message || "Evidence is unavailable.");
    return response.result;
  }

  async releaseCommit(settings: AppSettings, commitId: string, approval: HumanApproval, destination: string, validateApproval: () => Promise<boolean>): Promise<ReleaseResult> {
    const catalog = await this.catalog(settings);
    const commit = catalog.commits.find((item) => item.id === commitId);
    if (!commit) throw new Error("Release candidate is no longer present.");
    if (!approval.valid || approval.commitId !== commit.id || approval.projectId !== catalog.projectId || approval.workflowHash !== commit.workflowHash || approval.sourceRevision !== commit.sourceRevision) throw new Error("Human approval is missing, expired, or bound to another version.");
    if (!(await validateApproval())) throw new Error("Human approval was revoked before release started.");
    const destinationPath = await this.bridge.toRuntimePath(destination);
    await this.bridge.exec(["test", "-d", destinationPath]);
    await this.bridge.exec(["test", "-w", destinationPath]);
    const releaseId = createReleaseId(catalog.projectId, commit.id, approval.id, commit.artifacts);
    const safeName = commit.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "release";
    const finalPath = `${destinationPath}/Reify-${safeName}-${releaseId.slice(0, 12)}`;
    const manifestPath = `${finalPath}/release-manifest.json`;
    const exists = await this.bridge.exec(["test", "-f", manifestPath]).then(() => true).catch(() => false);
    if (exists) {
      const existing = JSON.parse((await this.bridge.exec(["cat", "--", manifestPath])).stdout) as { releaseId?: string; files?: ReleaseResult["files"] };
      if (existing.releaseId !== releaseId) throw new Error(`Release target exists with a different manifest: ${finalPath}`);
      return { releaseId, path: finalPath, manifestPath, reused: true, files: existing.files ?? [] };
    }
    const staging = `${destinationPath}/.reify-stage-${releaseId}-${Date.now()}`;
    const files: ReleaseResult["files"] = [];
    try {
      await this.bridge.exec(["mkdir", "-p", `${staging}/files`]);
      for (const artifact of commit.artifacts) {
        const source = await this.resolveProjectPath(settings, artifact.path);
        const before = (await this.bridge.exec(["sha256sum", "--", source])).stdout.split(/\s+/)[0];
        if (before !== artifact.sha256) throw new Error(`Approved artifact changed before packaging: ${artifact.path}`);
        const relative = normalizePath(artifact.path);
        if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) throw new Error(`Unsafe release artifact path: ${artifact.path}`);
        const target = `${staging}/files/${relative}`;
        await this.bridge.exec(["mkdir", "-p", target.slice(0, target.lastIndexOf("/"))]);
        await this.bridge.exec(["cp", "--", source, target]);
        const copied = (await this.bridge.exec(["sha256sum", "--", target])).stdout.split(/\s+/)[0];
        if (copied !== artifact.sha256) throw new Error(`Packaged artifact hash mismatch: ${artifact.path}`);
        files.push({ path: `files/${relative}`, sha256: artifact.sha256, role: artifact.role });
      }
      const summary = `${JSON.stringify(commit.acceptanceSummary ?? { requirements: [], assumptions: [] }, null, 2)}\n`;
      const approvalJson = `${JSON.stringify(approval, null, 2)}\n`;
      await this.bridge.exec(["tee", `${staging}/acceptance-summary.json`], { input: summary });
      await this.bridge.exec(["tee", `${staging}/human-approval.json`], { input: approvalJson });
      files.push({ path: "acceptance-summary.json", sha256: await hashRuntimeFile(this.bridge, `${staging}/acceptance-summary.json`), role: "acceptance-summary" });
      files.push({ path: "human-approval.json", sha256: await hashRuntimeFile(this.bridge, `${staging}/human-approval.json`), role: "human-approval" });
      const manifest = { schema: 1, releaseId, projectId: catalog.projectId, commitId: commit.id, workflowHash: commit.workflowHash, sourceRevision: commit.sourceRevision, approvalId: approval.id, scope: approval.scope, createdAt: new Date().toISOString(), files };
      await this.bridge.exec(["tee", `${staging}/release-manifest.json`], { input: `${JSON.stringify(manifest, null, 2)}\n` });
      if (!(await validateApproval())) throw new Error("Human approval was revoked while the package was being prepared.");
      for (const artifact of commit.artifacts) if (await hashRuntimeFile(this.bridge, await this.resolveProjectPath(settings, artifact.path)) !== artifact.sha256) throw new Error(`Approved artifact changed during packaging: ${artifact.path}`);
      await this.bridge.exec(["mv", "--", staging, finalPath]);
      return { releaseId, path: finalPath, manifestPath, reused: false, files };
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Partial output, if any, remains at ${staging}; retrying the same approved version creates or reuses one final release.`);
    }
  }

  async publishRemoteRelease(settings: AppSettings, release: ReleaseResult, remote: string, tag: string): Promise<RemotePublishResult> {
    if (!settings.remotePublish?.enabled) throw new Error("Remote publish is disabled by the administrator. The local release remains complete.");
    const target = remote.trim();
    if (!target || !settings.remotePublish.allowedRemotes.includes(target)) throw new Error(`Remote publish is incomplete: ${target || "the selected remote"} is not allowed. The local release remains complete.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(tag) || tag.includes("..") || tag.endsWith("/") || tag.includes("@{")) throw new Error("Remote publish is incomplete: enter a valid Git tag. The local release remains complete.");
    const { projectPath } = await this.bridge.resolveRuntimePaths(settings);
    const manifest = JSON.parse((await this.bridge.exec(["cat", "--", release.manifestPath])).stdout) as { releaseId?: string; sourceRevision?: string };
    if (manifest.releaseId !== release.releaseId || !/^[0-9a-f]{40,64}$/i.test(manifest.sourceRevision ?? "")) throw new Error("Remote publish is incomplete: the local release manifest is invalid. The local release remains complete.");
    const sourceRevision = manifest.sourceRevision!;
    await this.bridge.exec(["git", "-C", projectPath, "cat-file", "-e", `${sourceRevision}^{commit}`]);
    const statusBefore = (await this.bridge.exec(["git", "-C", projectPath, "status", "--porcelain=v1"])).stdout;
    const remoteUrl = (await this.bridge.exec(["git", "-C", projectPath, "remote", "get-url", target])).stdout.trim();
    try {
      const remoteRef = `refs/tags/${tag}`;
      const remoteLine = (await this.bridge.exec(["git", "-C", projectPath, "ls-remote", "--tags", target, remoteRef])).stdout.trim();
      if (remoteLine) {
        const remoteRevision = remoteLine.split(/\s+/)[0];
        if (remoteRevision !== sourceRevision) throw new Error(`remote tag ${tag} already exists at ${remoteRevision}`);
        return { releaseId: release.releaseId, remote: target, remoteUrl, tag, sourceRevision, state: "published", reused: true, packageUploaded: false };
      }
      const localRevision = await this.bridge.exec(["git", "-C", projectPath, "rev-parse", "-q", "--verify", remoteRef]).then((value) => value.stdout.trim()).catch(() => "");
      if (localRevision && localRevision !== sourceRevision) throw new Error(`local tag ${tag} already exists at ${localRevision}`);
      if (!localRevision) await this.bridge.exec(["git", "-C", projectPath, "tag", tag, sourceRevision]);
      await this.bridge.exec(["git", "-C", projectPath, "push", target, remoteRef], { timeout: 120_000 });
      const statusAfter = (await this.bridge.exec(["git", "-C", projectPath, "status", "--porcelain=v1"])).stdout;
      if (statusAfter !== statusBefore) throw new Error("working tree or index changed during remote publish");
      return { releaseId: release.releaseId, remote: target, remoteUrl, tag, sourceRevision, state: "published", reused: false, packageUploaded: false };
    } catch (error) {
      throw new Error(`Remote publish is incomplete: ${error instanceof Error ? error.message : String(error)}. The local release remains complete at ${release.path}; no remote tag was overwritten.`);
    }
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
