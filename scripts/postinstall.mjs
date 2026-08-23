#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { installSu2 } from "./install-su2.mjs";
import { installBlender } from "./install-blender.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pythonProject = join(root, "python");
const distro = process.env.PI_CAD_WSL_DISTRO ?? "Ubuntu";

function toWslPath(path) {
  const unc = path.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.*)$/i);
  if (unc) return `/${unc[2].replaceAll("\\", "/")}`;
  const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive?.[1].toUpperCase() === "V") return `/${drive[2].replaceAll("\\", "/")}`;
  return execFileSync("wsl.exe", ["-d", distro, "--", "wslpath", "-a", path.replaceAll("\\", "/")], {
    cwd: process.env.SystemRoot ?? "C:\\Windows",
    encoding: "utf-8",
    windowsHide: true,
  }).trim();
}

function uv(args, options = {}) {
  if (process.platform === "win32") {
    return execFileSync("wsl.exe", ["-d", distro, "--", "uv", ...args.map((arg) => arg === pythonProject ? toWslPath(arg) : arg)], {
      cwd: process.env.SystemRoot ?? "C:\\Windows",
      ...options,
    });
  }
  return execFileSync(process.env.PI_CAD_UV ?? "uv", args, { cwd: root, ...options });
}

// One reproducible Python project for cadctl. A Windows Node host always
// creates and runs it inside WSL; there is no Windows Python/uv fallback for
// a WSL-backed Pi-CAD checkout.
uv(["sync", "--project", pythonProject, "--extra", "simulation"], { stdio: "inherit" });

if (process.platform !== "win32") {
  const python = join(pythonProject, ".venv", "bin", "python");
  await installSu2({ root, python, env: process.env });
  await installBlender({ root, python, env: process.env });
}

const doctorText = uv(
  ["run", "--project", pythonProject, "--extra", "simulation", "--no-sync", "python", "-m", "cadctl", "doctor", "--json"],
  { encoding: "utf-8" },
);
const doctor = JSON.parse(doctorText.trim());
writeFileSync(join(root, ".pi-cad-runtime.json"), JSON.stringify({ mode: process.platform === "win32" ? "wsl-uv" : "uv", ...doctor }, null, 2));
console.log(`[pi-cad] Python runtime ready (${process.platform === "win32" ? `WSL ${distro}` : "native Linux"}): ${doctor.python}`);
console.log("[pi-cad] OpenFOAM 14 managed runtime is bootstrapped separately with scripts/bootstrap-openfoam14.sh");
