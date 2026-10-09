import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, sep } from "node:path";

export type WorkspacePathErrorCode = "outside_workspace" | "read_only" | "not_found";

export class WorkspacePathError extends Error {
  constructor(readonly code: WorkspacePathErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export type WorkspacePathOptions = { workspaceRoot: string; readOnlyRoots?: string[] };
export type ResolvedWorkspacePath = { abs: string; readOnly: boolean };

// Relative paths are taken from workspaceRoot. The candidate is joined without
// lexical normalisation so the kernel resolves `..` after symlinks, the same way
// realpath would. Files that do not exist yet resolve through their parent.
export async function resolveWorkspacePath(path: string, options: WorkspacePathOptions): Promise<ResolvedWorkspacePath> {
  const root = await realRoot(options.workspaceRoot);
  const readOnlyRoots = await Promise.all((options.readOnlyRoots ?? []).map(realRoot));
  const candidate = isAbsolute(path) ? path : `${options.workspaceRoot}${sep}${path}`;
  const abs = await realpathOrParent(candidate);
  const readOnly = readOnlyRoots.some((dir) => inside(abs, dir));
  if (!readOnly && !inside(abs, root)) throw new WorkspacePathError("outside_workspace", `${path} is outside the workspace`);
  return { abs, readOnly };
}

async function realpathOrParent(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  const name = basename(candidate);
  if (name === "" || name === "." || name === "..") throw new WorkspacePathError("not_found", `${candidate} has no file name`);
  const parent = await realpath(dirname(candidate)).catch((error: unknown) => {
    if (code(error) === "ENOENT") throw new WorkspacePathError("not_found", `${dirname(candidate)} does not exist`);
    throw error;
  });
  return `${parent}${sep}${name}`;
}

async function realRoot(dir: string): Promise<string> {
  return realpath(dir).catch(() => dir);
}

function inside(abs: string, dir: string): boolean {
  return abs === dir || abs.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
