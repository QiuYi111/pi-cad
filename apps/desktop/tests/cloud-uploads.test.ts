import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type Gateway } from "../../../cloud/workspace-gateway/src/server";
import { RemoteBridge } from "../electron/main/remote-bridge";
import { downloadForReveal, isWorkspacePath, safeUploadName, uploadChosenImages, uploadStepForImport } from "../electron/main/cloud-uploads";
import { importStepIntoProject } from "../electron/main/step-import";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

let base: string;
let root: string;
let gateway: Gateway;
let bridge: RemoteBridge;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "reify-uploads-"));
  root = join(base, "workspace");
  await mkdir(join(root, "projects", "p1"), { recursive: true });
  gateway = await startGateway({ port: 0, workspaceRoot: root, verifyToken: async () => true, exit: () => {} });
  const url = `ws://127.0.0.1:${gateway.port}/`;
  bridge = new RemoteBridge({
    workspaceRoot: root,
    projectId: () => "p1",
    connect: async () => {
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      return ws;
    },
  });
});

afterEach(async () => {
  bridge.close();
  await gateway.close();
  await rm(base, { recursive: true, force: true });
});

describe("upload on choose", () => {
  it("uploads chosen images into the project and returns their workspace paths", async () => {
    const image = randomBytes(4096);
    const local = join(base, "reference.png");
    await writeFile(local, image);
    const projectPath = join(root, "projects", "p1");

    const [uploaded] = await uploadChosenImages(bridge, [local], projectPath);
    expect(uploaded?.name).toBe("reference.png");
    expect(uploaded?.remotePath).toBe(`${projectPath}/.reify/uploads/${sha256(image).slice(0, 16)}-reference.png`);
    expect((await readFile(uploaded!.remotePath)).equals(image)).toBe(true);
  });

  it("uploads a STEP file to its imports path and imports it there without a second copy", async () => {
    const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
    const local = join(base, "bracket v2.step");
    await writeFile(local, step);
    const projectPath = join(root, "projects", "p1");

    const { fileName, remotePath } = await uploadStepForImport(bridge, local, projectPath);
    expect(fileName).toBe("bracket_v2.step");
    expect(remotePath).toBe(`${projectPath}/imports/${sha256(step).slice(0, 16)}-bracket_v2.step`);

    const relative = await importStepIntoProject(bridge, { source: remotePath, fileName, projectPath });
    expect(relative).toBe(`imports/${sha256(step).slice(0, 16)}-bracket_v2.step`);
    expect((await readFile(remotePath)).equals(step)).toBe(true);
  });

  it("keeps a safe name with its extension", () => {
    expect(safeUploadName("../../evil name.png")).toBe("evil_name.png");
    expect(safeUploadName("...hidden.step")).toBe("hidden.step");
  });
});

describe("download for reveal", () => {
  it("downloads a workspace file into the cache under its workspace-relative path", async () => {
    const calls: Array<[string, string]> = [];
    const fake = { download: async (remote: string, local: string) => { calls.push([remote, local]); return {}; } };
    const local = await downloadForReveal(fake, "/workspace/projects/p1/exports/model.step", "/cache");
    expect(local).toBe(join("/cache", "workspace", "projects", "p1", "exports", "model.step"));
    expect(calls).toEqual([["/workspace/projects/p1/exports/model.step", local]]);
  });

  it("refuses paths outside the workspace", async () => {
    const fake = { download: async () => ({}) };
    await expect(downloadForReveal(fake, "/workspace/../etc/passwd", "/cache")).rejects.toThrow("只能打开工作区中的文件");
    await expect(downloadForReveal(fake, "/opt/reify/pi-cad/x", "/cache")).rejects.toThrow("只能打开工作区中的文件");
    expect(isWorkspacePath("/workspace/projects/p1/a.step")).toBe(true);
    expect(isWorkspacePath("/workspacex/a")).toBe(false);
  });
});
