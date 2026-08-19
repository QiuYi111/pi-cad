#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installSu2 } from "./install-su2.mjs";
import { installBlender } from "./install-blender.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const requestedVenv = process.env.PI_CAD_VENV ?? join(root, ".venv");
const venvPython = process.platform === "win32" ? join(requestedVenv, "Scripts", "python.exe") : join(requestedVenv, "bin", "python");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

function has(cmd, args = ["--version"]) {
  try {
    execFileSync(cmd, args, { stdio: "ignore", cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function ensurePip(python) {
  if (has(python, ["-m", "pip", "--version"])) return;
  const getPip = join(root, ".python", "get-pip.py");
  mkdirSync(join(root, ".python"), { recursive: true });
  const res = await fetch("https://bootstrap.pypa.io/get-pip.py");
  if (!res.ok) throw new Error(`failed to download get-pip.py: ${res.status}`);
  writeFileSync(getPip, Buffer.from(await res.arrayBuffer()));
  run(python, [getPip, "--no-cache-dir"]);
}

function makeVenv() {
  if (has("uv", ["venv", "--help"])) {
    try {
      run("uv", ["venv", requestedVenv], {
        env: { ...process.env, XDG_CACHE_HOME: join(root, ".uv-cache") },
      });
      return true;
    } catch {
      // fall through to python -m venv
    }
  }
  try {
    run(process.platform === "win32" ? "py" : "python3", ["-m", "venv", requestedVenv]);
    return true;
  } catch {
    return false;
  }
}

// CuPy provides the CUDA sparse solver torch-fem needs on-device. Install the
// wheel matching torch's bundled CUDA when torch reports CUDA support; skip
// silently on CPU-only hosts and fail soft (device resolver falls back to CPU
// and doctor records cupyAvailable=false).
function torchCudaVersion(python, env) {
  try {
    const out = execFileSync(
      python,
      ["-c", "import torch; print(torch.version.cuda or '') if torch.cuda.is_available() else print('')"],
      { cwd: root, env, encoding: "utf-8" },
    );
    const version = out.trim();
    return version === "" ? null : version;
  } catch {
    return null;
  }
}

function installCupy(python, pipArgs, env, cudaVersion) {
  if (process.env.PI_CAD_SKIP_CUPY) {
    console.log("[pi-cad] PI_CAD_SKIP_CUPY set; skipping CuPy install (CUDA simulation stays optional)");
    return;
  }
  const major = cudaVersion.split(".")[0];
  const wheel = major === "12" ? "cupy-cuda12x" : major === "11" ? "cupy-cuda11x" : null;
  if (!wheel) {
    console.warn(`[pi-cad] torch CUDA ${cudaVersion} has no matching CuPy wheel; simulation falls back to CPU`);
    return;
  }
  try {
    run(python, [...pipArgs, wheel], { env });
    console.log(`[pi-cad] installed ${wheel} for torch CUDA ${cudaVersion}`);
  } catch {
    console.warn(`[pi-cad] ${wheel} install failed; CUDA simulation falls back to CPU until CuPy is available`);
  }
}

let python = venvPython;
let mode = "venv";
if (!existsSync(python) && !makeVenv()) {
  mode = "target";
  python = process.platform === "win32" ? "py" : "python3";
}

if (mode === "target") {
  mkdirSync(join(root, ".python", "pip-target"), { recursive: true });
  mkdirSync(join(root, ".python", "site-packages"), { recursive: true });
  if (!has(python, ["-m", "pip", "--version"])) {
    const getPip = join(root, ".python", "get-pip.py");
    const res = await fetch("https://bootstrap.pypa.io/get-pip.py");
    if (!res.ok) throw new Error(`failed to download get-pip.py: ${res.status}`);
    writeFileSync(getPip, Buffer.from(await res.arrayBuffer()));
    run(python, [getPip, "--target", join(root, ".python", "pip-target"), "--no-cache-dir"]);
  }
  const env = { ...process.env, PYTHONPATH: join(root, ".python", "pip-target") };
  run(python, ["-m", "pip", "install", "--target", join(root, ".python", "site-packages"), "-r", "python/requirements-core.txt"], { env });
  const pipTarget = ["-m", "pip", "install", "--target", join(root, ".python", "site-packages")];
  // Install torch on every platform. Linux CPU uses the CPU wheel index;
  // NVIDIA/macOS/Windows use the default PyTorch wheel for that platform.
  if (process.platform === "linux" && !has("nvidia-smi")) {
    run(python, [...pipTarget, "torch", "--index-url", "https://download.pytorch.org/whl/cpu"], { env });
  } else {
    run(python, [...pipTarget, "torch"], { env });
  }
  run(python, [...pipTarget, "-r", "python/requirements-simulation-runtime.txt"], { env });
  // Full torch-fem install first. If the optional pyamg build is unavailable
  // on this host, install the package without it; Pi-CAD records that pyamg
  // is unavailable and uses direct spsolve for the V1 small systems.
  try {
    run(python, [...pipTarget, "torch-fem"], { env });
  } catch {
    run(python, [...pipTarget, "--no-deps", "torch-fem"], { env });
  }
  const targetCuda = torchCudaVersion(python, env);
  if (targetCuda) installCupy(python, pipTarget, env, targetCuda);
} else {
  await ensurePip(python);
  run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(python, ["-m", "pip", "install", "-r", "python/requirements-core.txt"]);
  if (process.platform === "linux" && !has("nvidia-smi")) {
    run(python, ["-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cpu"]);
  } else {
    run(python, ["-m", "pip", "install", "torch"]);
  }
  run(python, ["-m", "pip", "install", "-r", "python/requirements-simulation-runtime.txt"]);
  try {
    run(python, ["-m", "pip", "install", "torch-fem"]);
  } catch {
    run(python, ["-m", "pip", "install", "--no-deps", "torch-fem"]);
  }
  const venvCuda = torchCudaVersion(python, process.env);
  if (venvCuda) installCupy(python, ["-m", "pip", "install"], process.env, venvCuda);
}

const pythonPath = [join(root, "python")]
  .concat(mode === "target" ? [join(root, ".python", "site-packages"), join(root, ".python", "pip-target")] : [])
  .concat(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])
  .join(delimiter);
const env = { ...process.env, PYTHONPATH: pythonPath };

// Optional runtimes first: the snapshot below is the install-time
// fallback diagnostic, so it must reflect the runtimes as installed.
await installSu2({ root, python, env });
await installBlender({ root, python, env });

const doctor = JSON.parse(
  execFileSync(python, ["-m", "cadctl", "doctor", "--json"], {
    cwd: root,
    env,
    encoding: "utf-8",
  }),
);
writeFileSync(join(root, ".pi-cad-runtime.json"), JSON.stringify({ mode, ...doctor }, null, 2));
console.log(
  `[pi-cad] runtime ready (${mode}): ${doctor.python} simulation=${doctor.capabilities?.simulation?.status ?? "unknown"} thermalFluid=${doctor.capabilities?.thermalFluid?.status ?? "unknown"}`,
);
