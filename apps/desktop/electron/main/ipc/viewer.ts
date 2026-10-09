import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { ModelParameterValue } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import { assertCloudAvailable, workspaceBridgeOf } from "../cloud-mode.js";
import { uploadStepForImport } from "../cloud-uploads.js";
import { importStepIntoProject } from "../step-import.js";
import { desktopE2E, desktopE2EOpenStep, stubWorkflowProjection, testExportStep, testOpenSteps } from "../desktop-e2e.js";
import type { MainServices } from "../services.js";

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

const demoParameterValues: Record<string, ModelParameterValue> = { width: 40, depth: 24, height: 12 };

const demo = desktopE2E;

/** STEP viewer, parameters, inspection, ParaView and Blender backends, and release commits. */
export function registerViewerIpc(s: MainServices) {
  ipcMain.handle(IPC.viewerChooseStep, async () => {
    if (testOpenSteps.length) return testOpenSteps.shift()!;
    if (desktopE2E && desktopE2EOpenStep) return desktopE2EOpenStep;
    const settings = await s.settingsStore.get();
    const result = await dialog.showOpenDialog(s.mainWindow!, { title: "Import STEP into project", defaultPath: settings.projectPath || undefined, properties: ["openFile"], filters: [{ name: "STEP model", extensions: ["step", "stp"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const host = await s.bridge();
    const { projectPath } = await host.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before importing STEP.");
    const remote = workspaceBridgeOf(host);
    if (remote) {
      const uploaded = await uploadStepForImport(remote, result.filePaths[0], projectPath);
      return importStepIntoProject(remote, { source: uploaded.remotePath, fileName: uploaded.fileName, projectPath });
    }
    const source = await host.toRuntimePath(result.filePaths[0]);
    const name = result.filePaths[0].split(/[\\/]/).at(-1) || "model.step";
    return importStepIntoProject(host, { source, fileName: name, projectPath });
  });
  ipcMain.handle(IPC.viewerLoadStep, async (_event, path: string) => demo ? demoMesh(path) : (await s.ensureViewer()).loadStep(await s.settingsStore.get(), path));
  ipcMain.handle(IPC.viewerExportStep, async (_event, source: string, expectedSha?: string) => {
    const settings = await s.settingsStore.get();
    const basename = source.split(/[\\/]/).at(-1) || "model.step";
    if (testExportStep) {
      if (!demo) await (await s.ensureViewer()).exportStep(settings, source, testExportStep, expectedSha);
      return testExportStep;
    }
    const result = await dialog.showSaveDialog(s.mainWindow!, {
      title: "Export STEP model",
      defaultPath: basename,
      filters: [{ name: "STEP model", extensions: ["step", "stp"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (demo) return result.filePath;
    const remote = workspaceBridgeOf(await s.bridge());
    if (remote) {
      // Export inside the workspace, then download the file to the chosen location.
      const { projectPath } = await remote.resolveRuntimePaths(settings);
      const staged = `${projectPath}/exports/${randomUUID()}-${result.filePath.split(/[\\/]/).at(-1) || "model.step"}`;
      await remote.exec(["mkdir", "-p", "--", `${projectPath}/exports`]);
      await (await s.ensureViewer()).exportStep(settings, source, staged, expectedSha);
      await remote.download(staged, result.filePath);
      await remote.exec(["rm", "-f", "--", staged]).catch(() => undefined);
      return result.filePath;
    }
    await (await s.ensureViewer()).exportStep(settings, source, result.filePath, expectedSha);
    return result.filePath;
  });
  ipcMain.handle(IPC.viewerCatalog, async () => stubWorkflowProjection ? {
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
  } : (await s.ensureViewer()).catalog(await s.settingsStore.get()));
  ipcMain.handle(IPC.viewerPreviewParameters, async (_event, path: string, values: Record<string, ModelParameterValue>) => {
    if (!demo) return (await s.ensureViewer()).previewParameters(await s.settingsStore.get(), path, values);
    if (Number(values.fillet_radius ?? 1) > 6) throw new Error("Fillet radius is too large for the selected body near the outer edge.");
    return demoMesh(`preview:${path}`, { ...demoParameterValues, ...values });
  });
  ipcMain.handle(IPC.viewerApplyParameters, async (_event, path: string, values: Record<string, ModelParameterValue>) => {
    if (demo) { Object.assign(demoParameterValues, values); return; }
    await (await s.ensureViewer()).applyParameters(await s.settingsStore.get(), path, values);
  });
  ipcMain.handle(IPC.viewerInspectGeometry, async (_event, path: string) => demo
    ? { source: path, sha256: "demo-step", units: "mm", bbox: { x: 40, y: 24, z: 12 }, solidCount: 3 }
    : (await s.ensureViewer()).inspectGeometry(await s.settingsStore.get(), path));
  ipcMain.handle(IPC.viewerInspectSection, async (_event, path: string, axis: "x" | "y" | "z") => demo
    ? { source: path, sha256: "demo-step", axis, position: axis === "x" ? 20 : axis === "y" ? 12 : 6, totalArea: axis === "z" ? 960 : axis === "y" ? 480 : 288, faceCount: 1, units: "mm" }
    : (await s.ensureViewer()).inspectSection(await s.settingsStore.get(), path, axis));
  ipcMain.handle(IPC.viewerOpenParaView, async (_event, path: string) => {
    if (demo) return { state: "ready", sourcePath: path, url: "pi-cad://demo-paraview" };
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "ParaView");
    return (await s.ensureParaView()).open(settings, path);
  });
  ipcMain.handle(IPC.viewerInspectSimulation, async (_event, path: string) => {
    if (demo) return { format: "VTK XML UnstructuredGrid (.vtu, ASCII)", source: path, pointCount: 842, cellCount: 1260, bounds: { x: [-20, 20], y: [-12, 12], z: [0, 12] }, fields: [{ name: "von Mises stress", association: "point", components: 1, min: 2.4, max: 82, unit: "MPa" }, { name: "displacement", association: "point", components: 3, min: 0, max: 0.34, unit: "mm" }], modelSource: "build/part.step#demo-step" };
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "ParaView");
    return (await s.ensureParaView()).inspect(settings, path);
  });
  ipcMain.handle(IPC.viewerStopParaView, async () => s.paraView?.stop());
  ipcMain.handle(IPC.viewerOpenParaViewDesktop, async (_event, path: string) => {
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "ParaView");
    return (await s.ensureParaView()).openDesktop(settings, path);
  });
  ipcMain.handle(IPC.viewerInspectBlender, async (_event, path: string) => {
    if (demo) return { source: path, scene: "product.blend", cameras: ["Hero", "Detail"], activeCamera: "Hero", objectCount: 8, frame: 1, frameStart: 1, frameEnd: 120 };
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "Blender");
    return (await s.ensureBlender()).inspect(settings, path);
  });
  ipcMain.handle(IPC.viewerInstallBlender, async () => {
    if (demo) return undefined;
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "Blender");
    return (await s.ensureBlender()).install(settings);
  });
  ipcMain.handle(IPC.viewerRenderBlender, async (_event, path: string, camera?: string) => {
    if (demo) return { path: ".pi-cad/renders/product.png", camera: camera || "Hero", dataUrl: "" };
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "Blender");
    return (await s.ensureBlender()).render(settings, path, camera);
  });
  ipcMain.handle(IPC.viewerOpenBlenderDesktop, async (_event, path: string) => {
    if (demo) return undefined;
    const settings = await s.settingsStore.get();
    assertCloudAvailable(settings, "Blender");
    return (await s.ensureBlender()).openDesktop(settings, path);
  });
  ipcMain.handle(IPC.viewerStopBlender, async () => s.blender?.stop());
  ipcMain.handle(IPC.viewerRebuildCommit, async (_event, commitId: string, manifestPath: string) => (await s.ensureViewer()).rebuildCommit(await s.settingsStore.get(), commitId, manifestPath));
  ipcMain.handle(IPC.viewerReadEvidence, async (_event, path: string) => (await s.ensureViewer()).readEvidence(await s.settingsStore.get(), path));
}
