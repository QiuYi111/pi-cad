#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { installBlender } from "./install-blender.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pythonProject = join(root, "python");
function uv(args, options = {}) {
  return execFileSync(process.env.PI_CAD_UV ?? "uv", args, { cwd: root, ...options });
}

if (process.platform !== "linux") {
  throw new Error("Pi-CAD installation must run inside Linux or WSL; Windows-host Node is unsupported");
}

// One reproducible Python project for cadctl, entirely inside Linux/WSL.
uv(["sync", "--project", pythonProject, "--extra", "simulation"], { stdio: "inherit" });

const python = join(pythonProject, ".venv", "bin", "python");
await installBlender({ root, python, env: process.env });

const doctorText = uv(
  ["run", "--project", pythonProject, "--extra", "simulation", "--no-sync", "python", "-m", "cadctl", "doctor", "--json"],
  { encoding: "utf-8" },
);
const doctor = JSON.parse(doctorText.trim());
writeFileSync(join(root, ".pi-cad-runtime.json"), JSON.stringify({ mode: "linux-uv", ...doctor }, null, 2));
console.log(`[pi-cad] Python runtime ready (Linux/WSL): ${doctor.python}`);
console.log("[pi-cad] OpenFOAM 14 managed runtime is bootstrapped separately with scripts/bootstrap-openfoam14.sh");
console.log("[pi-cad] SU2 and torch-fem managed runtimes are bootstrapped explicitly; npm postinstall never downloads solvers");
