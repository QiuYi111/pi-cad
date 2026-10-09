/**
 * Publish the SolidWorks executor (C#) into executors/solidworks/publish.
 * The Windows package takes that folder as resources/executors/solidworks.
 * Equivalent to:
 *   dotnet publish executors/solidworks/ReifyExport -c Release -r win-x64 --self-contained false -o executors/solidworks/publish
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function publishArguments(root) {
  return ["publish", resolve(root, "executors/solidworks/ReifyExport"), "-c", "Release", "-r", "win-x64", "--self-contained", "false", "-o", resolve(root, "executors/solidworks/publish")];
}

export function buildSolidworksExecutor({ root = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), spawn = spawnSync, exists = existsSync } = {}) {
  if (!exists(resolve(root, "executors/solidworks/ReifyExport"))) {
    throw new Error("The SolidWorks executor project executors/solidworks/ReifyExport does not exist.");
  }
  for (const dotnet of ["dotnet", "dotnet.exe"]) {
    const result = spawn(dotnet, publishArguments(root), { stdio: "inherit" });
    if (result.error && result.error.code === "ENOENT") continue;
    if (result.status !== 0) throw new Error(`dotnet publish failed (exit ${result.status}). The Windows package needs the SolidWorks executor.`);
    return;
  }
  throw new Error("The .NET SDK is missing. Install the .NET 8 SDK from https://dotnet.microsoft.com/download. The Windows package needs it to build the SolidWorks executor.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { buildSolidworksExecutor(); } catch (error) { console.error(error.message); process.exit(1); }
}
