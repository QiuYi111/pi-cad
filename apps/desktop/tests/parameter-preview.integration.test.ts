import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ViewerBackend } from "../electron/main/viewer";
import type { RuntimeBridge } from "../electron/main/runtime-bridge";
import type { AppSettings } from "../src/shared/contracts";
import { handleAgentApi } from "../../../src/agent-api/handlers";
import { shutdownWarmCadctlWorkers } from "../../../src/shared/cadctl-worker";

const repository = resolve(import.meta.dirname, "../../..");

afterEach(() => shutdownWarmCadctlWorkers());

function testBridge(projectPath: string): RuntimeBridge {
  const run = (args: string[], input?: string, timeout = 180_000) => new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`test process timed out: ${args[0]}`)); }, timeout);
    if (input === undefined) child.stdin.end(); else child.stdin.end(input);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) accept({ stdout, stderr });
      else reject(new Error(stderr || `test process exited ${code}`));
    });
  });
  return {
    kind: "native",
    spawn: (args) => spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"] }),
    exec: (args, options) => run(args, options?.input, options?.timeout),
    pipe: (args, input, timeout) => run(args, input, timeout),
    toRuntimePath: async (value) => value,
    homeDirectory: async () => "/tmp",
    commandPath: async (name) => name === "node" ? process.execPath : "uv",
    resolveRuntimePaths: async () => ({ piCadRepo: repository, primeAgentRepo: "", projectPath }),
    check: async () => ({ state: "idle", checks: [] }),
    install: async () => ({ state: "idle", checks: [] }),
    installWsl: async () => ({ state: "idle", checks: [] }),
    checkSimulationComponent: async () => ({ state: "ready", component: "torch-fem-0.9", detail: "test runtime", estimatedSize: "6 GB" }),
    installSimulationComponent: async () => ({ state: "ready", component: "torch-fem-0.9", detail: "test runtime", estimatedSize: "6 GB" }),
    revealPath: async (value) => value,
  };
}

describe("real parameter preview path", () => {
  it("measures and sections a known STEP without changing its hash", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-cad-quick-check-"));
    const artifact = join(project, "known-box.step");
    await copyFile(join(repository, "tests/fixtures/section_box.step"), artifact);
    const settings = { projectPath: project, piCadRepo: repository } as AppSettings;
    const viewer = new ViewerBackend(testBridge(project));
    const hash = async () => createHash("sha256").update(await readFile(artifact)).digest("hex");
    try {
      const before = await hash();
      const geometry = await viewer.inspectGeometry(settings, artifact);
      expect(geometry).toMatchObject({ units: "mm", bbox: { x: 40, y: 30, z: 12 }, solidCount: 1, sha256: before });
      const section = await viewer.inspectSection(settings, artifact, "z");
      expect(section).toMatchObject({ units: "mm", axis: "z", position: 0, totalArea: 1200, faceCount: 1, sha256: before });
      expect(await hash()).toBe(before);
    } finally {
      viewer.stop();
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);

  it("reuses the warm worker for preview and applies through the authorized build path", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-cad-parameter-preview-"));
    const canonical = await mkdtemp(join(tmpdir(), "pi-cad-parameter-preview-state-"));
    const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
    const settings = { projectPath: project, piCadRepo: repository } as AppSettings;
    const bridge = testBridge(project);
    const viewer = new ViewerBackend(bridge);
    try {
      await writeFile(join(project, "dimensions.py"), "DEPTH = 24\n");
      await writeFile(join(project, "box.py"), [
        "import build123d as bd",
        "from dimensions import DEPTH",
        "def build(parameters):",
        "    if parameters['fillet_radius'] * 2 >= min(parameters['width'], DEPTH, parameters['height']):",
        "        raise ValueError('fillet radius is too large for the selected body')",
        "    plate = bd.Box(parameters['width'], DEPTH, parameters['height'])",
        "    hole = bd.Pos(parameters['width'] / 2, DEPTH / 2, 0) * bd.Cylinder(parameters['hole_diameter'] / 2, parameters['height'])",
        "    return plate - hole",
        "",
      ].join("\n"));
      await handleAgentApi(project, { schema: 1, op: "workflow-start", id: "mechanical.quick-build", interactionMode: "headless" });
      await handleAgentApi(project, { schema: 1, op: "commit", name: "quick-build", artifacts: ["box.py", "dimensions.py"] });
      const built = await handleAgentApi(project, {
        schema: 1, op: "model-build", source: "box.py", output: "build/box.step",
        parameters: {
          width: { default: 40, min: 20, max: 80, step: 1, unit: "mm" },
          depth: { default: 24, min: 12, max: 48, step: 1, unit: "mm" },
          height: { default: 12, min: 4, max: 30, step: 1, unit: "mm" },
          hole_diameter: { default: 6, min: 3, max: 16, step: 0.5, unit: "mm" },
          fillet_radius: { default: 1, min: 0, max: 20, step: 0.5, unit: "mm" },
        },
      }) as any;
      const manifestPath = built.parameterManifest.path as string;

      const preview = await viewer.previewParameters(settings, manifestPath, { width: 61 });
      expect(preview.bounds.max[0] - preview.bounds.min[0]).toBeCloseTo(61, 5);
      expect(preview.bounds.max[1] - preview.bounds.min[1]).toBeCloseTo(24, 5);

      const inspect = async (path: string) => JSON.parse((await bridge.exec([
        "uv", "run", "--project", join(repository, "python"), "cadctl", "inspect", "--artifact", path,
      ])).stdout).payload;
      expect((await inspect(preview.source)).cylinders.map((face: any) => face.radius)).toContain(3);
      const widerHole = await viewer.previewParameters(settings, manifestPath, { width: 61, hole_diameter: 12 });
      expect(widerHole.sha256).not.toBe(preview.sha256);
      expect((await inspect(widerHole.source)).cylinders.map((face: any) => face.radius)).toContain(6);

      const committed = await handleAgentApi(project, {
        schema: 1, op: "commit", name: "release",
        artifacts: ["box.py", "build/box.step", manifestPath],
      }) as { id: string; sourceRevision?: string };
      expect(committed.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
      const historyCatalog = await viewer.catalog(settings);
      const historicalManifest = historyCatalog.parameterManifests.find((item) => item.path.startsWith(`@commit/${committed.id}/`));
      expect(historicalManifest).toBeTruthy();
      await writeFile(join(project, "staged-notes.txt"), "staged user edit\n");
      await bridge.exec(["git", "-C", project, "add", "staged-notes.txt"]);
      await writeFile(join(project, "notes.txt"), "untracked user note\n");
      const dirtyBefore = (await bridge.exec(["git", "-C", project, "status", "--porcelain=v1"])).stdout;
      const reproduction = await viewer.rebuildCommit(settings, committed.id, historicalManifest!.path);
      expect(reproduction.geometryMatch, reproduction.geometryDetail).toBe(true);
      expect(reproduction.sourceRevision).toBe(committed.sourceRevision);
      expect(reproduction.parameters).toMatchObject({ width: 40, hole_diameter: 6 });
      expect((await bridge.exec(["git", "-C", project, "status", "--porcelain=v1"])).stdout).toBe(dirtyBefore);
      await bridge.exec(["git", "-C", project, "reset"]);
      await rm(join(project, "staged-notes.txt"));
      await rm(join(project, "notes.txt"));
      await writeFile(join(project, "dimensions.py"), "DEPTH = 30\n");
      const dependencyChanged = await viewer.previewParameters(settings, manifestPath, { width: 62 });
      expect(dependencyChanged.bounds.max[1] - dependencyChanged.bounds.min[1]).toBeCloseTo(30, 5);
      await expect(viewer.previewParameters(settings, manifestPath, { fillet_radius: 10 }))
        .rejects.toThrow(/fillet radius is too large/);
      const recovered = await viewer.previewParameters(settings, manifestPath, { fillet_radius: 2 });
      expect(recovered.parts.length).toBeGreaterThan(0);
      await handleAgentApi(project, { schema: 1, op: "workflow-advance", event: "delivered" });

      await viewer.applyParameters(settings, manifestPath, { width: 68 });
      const parameterRun = await handleAgentApi(project, { schema: 1, op: "workflow-current" }) as any;
      expect(parameterRun).toMatchObject({ workflowId: "mechanical.parameter-edit", phase: "done", status: "done" });
      const catalog = await viewer.catalog(settings);
      const appliedManifest = catalog.parameterManifests[0]?.manifest;
      expect(appliedManifest?.parameters.find((item) => item.id === "width")?.value).toBe(68);
      expect((await viewer.loadStep(settings, appliedManifest!.output.path)).sha256).toBe(appliedManifest!.output.sha256);

      await handleAgentApi(project, { schema: 1, op: "workflow-start", id: "mechanical.analysis", interactionMode: "headless" });
      const promotedCatalog = await viewer.catalog(settings);
      expect(promotedCatalog.parameterManifests[0]?.manifest.parameters.find((item) => item.id === "width")?.value).toBe(68);
    } finally {
      viewer.stop();
      if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
      else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
      await rm(project, { recursive: true, force: true });
      await rm(canonical, { recursive: true, force: true });
    }
  }, 180_000);
});
