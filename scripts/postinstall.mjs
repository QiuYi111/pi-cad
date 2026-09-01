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

if (process.platform !== "linux" && process.platform !== "darwin") {
  throw new Error("Pi-CAD installation requires Linux, macOS, or Linux through WSL");
}

// macOS ships the CAD core. Linux additionally qualifies the managed
// simulation stack whose solver runtimes and Bubblewrap boundary are Linux-only.
const pythonArgs = ["--project", pythonProject, ...(process.platform === "linux" ? ["--extra", "simulation"] : [])];
uv(["sync", ...pythonArgs], { stdio: "inherit" });

const python = join(pythonProject, ".venv", "bin", "python");
if (process.platform === "linux") await installBlender({ root, python, env: process.env });
else console.log("[pi-cad] managed Blender is not bundled on macOS; use a PATH Blender installation when needed");

const doctorText = uv(
  ["run", ...pythonArgs, "--no-sync", "python", "-m", "cadctl", "doctor", "--json"],
  { encoding: "utf-8" },
);
const doctor = JSON.parse(doctorText.trim());
writeFileSync(join(root, ".pi-cad-runtime.json"), JSON.stringify({ mode: "linux-uv", ...doctor }, null, 2));
console.log(`[pi-cad] Python runtime ready (${process.platform}): ${doctor.python}`);
console.log("[pi-cad] OpenFOAM 14 managed runtime is bootstrapped separately with scripts/bootstrap-openfoam14.sh");
console.log("[pi-cad] SU2 and torch-fem managed runtimes are bootstrapped explicitly; npm postinstall never downloads solvers");
