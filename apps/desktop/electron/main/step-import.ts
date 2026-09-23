import { randomUUID } from "node:crypto";
import type { RuntimeBridge } from "./runtime-bridge.js";

const SHA256 = /^[0-9a-f]{64}$/;
const STEP_FILE_NAME = /^[^\\/]+\.(step|stp)$/i;
// `missing` keeps the probe exit code 0 so a missing project copy is not an error.
const READ_HASH = 'if [ -f "$1" ]; then sha256sum -- "$1"; else printf missing; fi';

/** The slice of the runtime bridge a STEP import needs. */
export type StepImportRuntime = Pick<RuntimeBridge, "exec">;

export function stepImportRelativePath(fileName: string, sourceHash: string): string {
  if (!SHA256.test(sourceHash)) throw new Error("Could not verify the selected STEP file.");
  if (!STEP_FILE_NAME.test(fileName)) throw new Error("Select a .step or .stp file.");
  return `imports/${sourceHash.slice(0, 16)}-${fileName}`;
}

/** Content hash of a runtime file, or null when it does not exist yet. */
async function contentHash(runtime: StepImportRuntime, path: string): Promise<string | null> {
  const { stdout } = await runtime.exec(["sh", "-c", READ_HASH, "step-import", path]);
  const value = stdout.trim().split(/\s+/)[0] || "";
  if (value === "missing") return null;
  if (!SHA256.test(value)) throw new Error(`Could not verify ${path}.`);
  return value;
}

/**
 * Copy the chosen STEP file into the project `imports/` folder under its content hash.
 * An existing project copy is reused only when its bytes match the selection; a fresh
 * copy is verified before it is published, so callers never receive a path whose
 * content differs from the file the user picked.
 */
export async function importStepIntoProject(
  runtime: StepImportRuntime,
  { source, fileName, projectPath }: { source: string; fileName: string; projectPath: string },
): Promise<string> {
  if (!projectPath) throw new Error("Choose a project before importing STEP.");
  const sourceHash = await contentHash(runtime, source);
  if (sourceHash === null) throw new Error("Could not read the selected STEP file.");
  const relative = stepImportRelativePath(fileName, sourceHash);
  const importsDirectory = `${projectPath.replace(/\/+$/, "")}/imports`;
  const destination = `${importsDirectory}/${relative.slice("imports/".length)}`;
  if (source === destination) return relative;

  await runtime.exec(["mkdir", "-p", "--", importsDirectory]);
  const existingHash = await contentHash(runtime, destination);
  if (existingHash !== null) {
    if (existingHash !== sourceHash) throw new Error(duplicateMessage(relative));
    return relative;
  }

  // Stage, verify, then publish. Anything that does not match the selection is
  // removed instead of being reported as a successful import.
  const staged = `${importsDirectory}/.${randomUUID()}.part`;
  try {
    await runtime.exec(["cp", "--", source, staged], { timeout: 120_000 });
    if ((await contentHash(runtime, staged)) !== sourceHash) {
      throw new Error("The STEP copy did not match the selected file. Nothing was imported.");
    }
    await runtime.exec(["mv", "-n", "--", staged, destination]);
    if ((await contentHash(runtime, destination)) !== sourceHash) throw new Error(duplicateMessage(relative));
  } finally {
    await runtime.exec(["rm", "-f", "--", staged]).catch(() => undefined);
  }
  return relative;
}

function duplicateMessage(relative: string): string {
  return `The project already has different content at ${relative}. Rename or remove that file, then import again.`;
}
