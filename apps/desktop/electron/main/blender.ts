import { readFile } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { posix } from "node:path";
import type { AppSettings, BlenderRender, BlenderScene } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

function resultLine<T>(stdout: string): T {
  const line = stdout.split("\n").reverse().find((value: string) => value.startsWith("REIFY_JSON:"));
  if (!line) throw new Error("Blender did not return scene metadata.");
  return JSON.parse(line.slice("REIFY_JSON:".length)) as T;
}

export class BlenderBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private editor: ChildProcessWithoutNullStreams | null = null;
  constructor(private readonly bridge: RuntimeBridge) {}

  private async paths(settings: AppSettings, source: string) {
    const runtime = await this.bridge.resolveRuntimePaths(settings);
    if (!/\.blend$/i.test(source)) throw new Error("Choose a Blender .blend scene.");
    const requestedScene = source.startsWith("/") ? source : `${runtime.projectPath}/${source}`;
    const project = (await this.bridge.exec(["realpath", "-e", "--", runtime.projectPath])).stdout.trim();
    const scene = (await this.bridge.exec(["realpath", "-e", "--", requestedScene])).stdout.trim();
    const relative = posix.relative(project, scene);
    if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) throw new Error("Blender scene must remain inside the active project.");
    const probe = await this.bridge.exec(["bash", "-lc", `command -v blender || find ${JSON.stringify(`${runtime.piCadRepo}/.runtime/blender`)} -type f -name blender -perm -111 | head -1`]);
    const blender = probe.stdout.trim();
    if (!blender) throw new Error("Blender is not installed. Install the optional presentation component first.");
    return { ...runtime, scene, blender, script: `${runtime.piCadRepo}/scripts/desktop-blender-scene.py` };
  }

  async inspect(settings: AppSettings, source: string): Promise<BlenderScene> {
    const paths = await this.paths(settings, source);
    const { stdout } = await this.bridge.exec([paths.blender, "--background", paths.scene, "--python", paths.script, "--", "inspect"], { timeout: 120_000 });
    const hash = (await this.bridge.exec(["sha256sum", "--", paths.scene])).stdout.split(/\s+/)[0];
    return { ...resultLine<Omit<BlenderScene, "source">>(stdout), source, sha256: hash };
  }

  async install(settings: AppSettings): Promise<void> {
    const runtime = await this.bridge.resolveRuntimePaths(settings);
    const node = await this.bridge.commandPath("node");
    await this.bridge.exec([node, `${runtime.piCadRepo}/scripts/install-blender.mjs`], { timeout: 1_800_000 });
  }

  async render(settings: AppSettings, source: string, camera?: string): Promise<BlenderRender> {
    const paths = await this.paths(settings, source);
    const output = `${paths.projectPath}/.pi-cad/renders/${source.split(/[\\/]/).at(-1)}-${Date.now()}.png`;
    const args = [paths.blender, "--background", paths.scene, "--python", paths.script, "--", "render", "--output", output, ...(camera ? ["--camera", camera] : [])];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = this.bridge.spawn(args); this.child = child;
      let out = ""; let error = "";
      child.stdout.on("data", (chunk) => { out += chunk.toString(); });
      child.stderr.on("data", (chunk) => { error += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => { this.child = null; code === 0 ? resolve(out) : reject(new Error(error || `Blender exited ${code}`)); });
    });
    const result = resultLine<{ path: string; camera: string }>(stdout);
    const bytes = await readFile(result.path);
    return { path: result.path, camera: result.camera, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  }

  async openDesktop(settings: AppSettings, source: string): Promise<void> {
    const paths = await this.paths(settings, source);
    if (this.editor && this.editor.exitCode === null) return;
    this.editor = this.bridge.spawn([paths.blender, paths.scene]);
    this.editor.once("exit", () => { this.editor = null; });
  }

  stop(): void { this.child?.kill("SIGTERM"); this.child = null; }
}
