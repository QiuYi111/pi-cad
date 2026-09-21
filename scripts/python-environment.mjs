import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export function removeBrokenPythonEnvironment(pythonProject) {
  const environment = join(pythonProject, ".venv");
  const python = join(environment, "bin", "python");
  if (!existsSync(environment) || existsSync(python)) return false;
  rmSync(environment, { recursive: true, force: true });
  return true;
}
