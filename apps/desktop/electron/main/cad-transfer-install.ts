import {
  FUSION_ADDIN_NAME, FUSION_MANIFEST_NAME, fusionAddinsDir, hostPath,
} from "./cad-transfer-paths.js";
import { bundledAddinVersion, installedAddinVersion, manifestVersion, type DetectDeps } from "./cad-transfer-detect.js";

export interface InstallResult { version: string; folder: string; replacedVersion: string | null }

/**
 * Copy the bundled ReifyExport add-in into Fusion's AddIns folder.
 * An older copy is removed first, so no stale file stays behind.
 */
export async function installFusionAddin(deps: Pick<DetectDeps, "fs" | "host" | "bundledFusionAddin">): Promise<InstallResult> {
  const addins = fusionAddinsDir(deps.host);
  if (!addins) throw new Error("Fusion add-ins work on Windows and macOS only.");
  const source = deps.bundledFusionAddin;
  const p = hostPath(deps.host.platform);
  if (!source || !(await deps.fs.exists(p.join(source, FUSION_MANIFEST_NAME)))) {
    throw new Error("The ReifyExport add-in is not part of this Reify install. Install Reify again.");
  }
  const bundled = await bundledAddinVersion(deps);
  if (!bundled) throw new Error("The bundled add-in manifest has no version.");
  const folder = p.join(addins, FUSION_ADDIN_NAME);
  const before = await installedAddinVersion(deps);
  await deps.fs.mkdirp(addins);
  if (await deps.fs.exists(folder)) await deps.fs.rm(folder);
  await deps.fs.cp(source, folder);
  const after = manifestVersion(await deps.fs.readText(p.join(folder, FUSION_MANIFEST_NAME)));
  if (after !== bundled) throw new Error("Reify could not copy the add-in. Close Fusion and try again.");
  return { version: after, folder, replacedVersion: before && before !== "unreadable" ? before : null };
}
