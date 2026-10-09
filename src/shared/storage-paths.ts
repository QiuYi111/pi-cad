import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CANONICAL_DIRECTORY_ENV = "PI_CAD_CANONICAL_PROJECT_DIR";

export function canonicalProjectKey(cwd: string): string {
  return createHash("sha256").update(realpathSync(resolve(cwd))).digest("hex");
}

export function defaultCanonicalProjectDirectory(cwd: string): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? resolve(process.env.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  return join(dataHome, "pi-cad", canonicalProjectKey(cwd));
}

/** Direct library tests retain prototype storage unless a sidecar supplies its private root. */
export function harnessStorageRoot(cwd: string): string {
  const configured = process.env[CANONICAL_DIRECTORY_ENV];
  if (!configured) return join(resolve(cwd), ".pi-cad");
  if (!isAbsolute(configured)) throw new Error(`${CANONICAL_DIRECTORY_ENV} must be absolute`);
  return resolve(configured);
}

export function harnessRunDirectory(cwd: string, runId: string): string {
  return join(harnessStorageRoot(cwd), "runs", runId);
}

export function harnessProjectDirectory(cwd: string): string {
  return join(harnessStorageRoot(cwd), "v7-project");
}
