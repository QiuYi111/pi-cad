import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, join, posix } from "node:path";
import { stepImportRelativePath } from "./step-import.js";

const WORKSPACE_ROOT = "/workspace";

/** The one bridge call the upload helpers need. RemoteBridge implements it. */
export interface UploadBridge {
  upload(localPath: string, remotePath: string): Promise<{ size: number; sha256: string }>;
}

export interface UploadedImage {
  /** Name as chosen on this computer. */
  name: string;
  /** Where the file now lives in the workspace. */
  remotePath: string;
}

export async function hashLocalFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A file name that is safe on the workspace filesystem and keeps its extension. */
export function safeUploadName(fileName: string): string {
  const cleaned = basename(fileName).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned || "file";
}

/**
 * Uploads chosen images into `<project>/.reify/uploads/` under their content hash,
 * so the same picture is stored once and the path can be handed to Prime.
 */
export async function uploadChosenImages(bridge: UploadBridge, localPaths: string[], projectPath: string): Promise<UploadedImage[]> {
  const uploaded: UploadedImage[] = [];
  for (const localPath of localPaths) {
    const sha256 = await hashLocalFile(localPath);
    const remotePath = posix.join(projectPath, ".reify", "uploads", `${sha256.slice(0, 16)}-${safeUploadName(localPath)}`);
    await bridge.upload(localPath, remotePath);
    uploaded.push({ name: basename(localPath), remotePath });
  }
  return uploaded;
}

/**
 * Uploads a chosen STEP file to the content-addressed place in `<project>/imports/`
 * that the import step would pick, so the import needs no second copy.
 */
export async function uploadStepForImport(bridge: UploadBridge, localPath: string, projectPath: string): Promise<{ fileName: string; remotePath: string }> {
  const sha256 = await hashLocalFile(localPath);
  const fileName = safeUploadName(localPath);
  const relative = stepImportRelativePath(fileName, sha256);
  const remotePath = `${projectPath.replace(/\/+$/, "")}/${relative}`;
  await bridge.upload(localPath, remotePath);
  return { fileName, remotePath };
}

/**
 * Downloads a workspace file into the local cache so it can be shown in the file
 * manager. Only files under /workspace are accepted; directories are not synced.
 */
export async function downloadForReveal(bridge: { download(remotePath: string, localPath: string): Promise<unknown> }, remotePath: string, cacheRoot: string): Promise<string> {
  const normalized = posix.normalize(remotePath);
  const relative = posix.relative(WORKSPACE_ROOT, normalized);
  if (!relative || relative.startsWith("..") || posix.isAbsolute(relative)) throw new Error("只能打开工作区中的文件。");
  const local = join(cacheRoot, "workspace", ...relative.split("/"));
  await bridge.download(normalized, local);
  return local;
}

export function isWorkspacePath(path: string): boolean {
  return posix.normalize(path).startsWith(`${WORKSPACE_ROOT}/`);
}
