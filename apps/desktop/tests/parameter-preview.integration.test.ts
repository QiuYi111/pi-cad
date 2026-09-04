import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    revealPath: async (value) => value,
  };
}

describe("real parameter preview path", () => {
  it("reuses the warm worker for preview and applies through the authorized build path", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-cad-parameter-preview-"));
    const canonical = await mkdtemp(join(tmpdir(), "pi-cad-parameter-preview-state-"));
    const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
    const settings = { projectPath: project, piCadRepo: repository } as AppSettings;
    const viewer = new ViewerBackend(testBridge(project));
    try {
      await writeFile(join(project, "box.py"), [
        "import build123d as bd",
        "def build(parameters):",
        "    return bd.Box(parameters['width'], parameters['depth'], parameters['height'])",
        "",
      ].join("\n"));
      await handleAgentApi(project, { schema: 1, op: "workflow-start", id: "mechanical.benchmark-build", interactionMode: "headless" });
      const built = await handleAgentApi(project, {
        schema: 1, op: "model-build", source: "box.py", output: "build/box.step",
        parameters: {
          width: { default: 40, min: 20, max: 80, step: 1, unit: "mm" },
          depth: { default: 24, min: 12, max: 48, step: 1, unit: "mm" },
          height: { default: 12, min: 4, max: 30, step: 1, unit: "mm" },
        },
      }) as any;
      const manifestPath = built.parameterManifest.path as string;

      const preview = await viewer.previewParameters(settings, manifestPath, { width: 61 });
      expect(preview.bounds.max[0] - preview.bounds.min[0]).toBeCloseTo(61, 5);
      expect(preview.bounds.max[1] - preview.bounds.min[1]).toBeCloseTo(24, 5);

      await handleAgentApi(project, {
        schema: 1, op: "commit", name: "release",
        artifacts: ["box.py", "build/box.step", manifestPath],
      });
      await handleAgentApi(project, { schema: 1, op: "workflow-advance", event: "delivered" });

      await viewer.applyParameters(settings, manifestPath, { width: 68 });
      const parameterRun = await handleAgentApi(project, { schema: 1, op: "workflow-current" }) as any;
      expect(parameterRun).toMatchObject({ workflowId: "mechanical.parameter-edit", phase: "done", status: "done" });
      const catalog = await viewer.catalog(settings);
      expect(catalog.parameterManifests[0]?.manifest.parameters.find((item) => item.id === "width")?.value).toBe(68);

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
