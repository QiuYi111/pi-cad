#!/usr/bin/env node
/**
 * Optional SU2 runtime installer for Pi-CAD.
 *
 * Flow/thermal simulation is an optional capability: a failed download must
 * never break `npm install`. PI_CAD_SKIP_SU2=1 opts out entirely;
 * PI_CAD_SU2_BIN bypasses the managed runtime with an external binary.
 *
 * Layout: .runtime/su2/<version>/<platform>/bin/SU2_CFD
 * The manifest pins the official release URL and its SHA256; archives are
 * nested zips (outer download -> inner distribution zip), and only
 * bin/SU2_CFD is extracted.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as PathResolve } from "node:path";

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function platformKey() {
  if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win32-x64";
  return null;
}

function pythonExtract(python, env, root, zipPath, member, destPath) {
  // The Python runtime guaranteed by postinstall does the nested-zip
  // extraction; Node has no built-in zip reader.
  const script =
    "import sys, zipfile, io, os\n" +
    "outer = zipfile.ZipFile(sys.argv[1])\n" +
    "inner_name = outer.namelist()[0]\n" +
    "inner = zipfile.ZipFile(io.BytesIO(outer.read(inner_name)))\n" +
    "data = inner.read(sys.argv[2])\n" +
    "os.makedirs(os.path.dirname(sys.argv[3]), exist_ok=True)\n" +
    "open(sys.argv[3], 'wb').write(data)\n";
  execFileSync(python, ["-c", script, zipPath, member, destPath], { cwd: root, env, stdio: "pipe" });
}

export async function installSu2({ root, python, env = process.env }) {
  if (process.env.PI_CAD_SKIP_SU2) {
    console.log("[pi-cad] PI_CAD_SKIP_SU2 set; skipping SU2 install (flow/thermal simulation disabled)");
    return { status: "skipped" };
  }
  if (process.env.PI_CAD_SU2_BIN) {
    console.log("[pi-cad] PI_CAD_SU2_BIN set; using external SU2 binary");
    return { status: "external" };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "scripts", "su2-manifest.json"), "utf-8"));
  } catch {
    console.warn("[pi-cad] SU2 manifest unreadable; flow/thermal simulation disabled");
    return { status: "unavailable" };
  }
  const key = platformKey();
  const entry = key && manifest.platforms?.[key];
  if (!entry) {
    console.warn(`[pi-cad] no SU2 build for platform ${key ?? process.platform}; flow/thermal simulation disabled`);
    return { status: "unavailable" };
  }
  const version = manifest.version ?? "unknown";
  // PI_CAD_SU2_RUNTIME relocates the whole managed runtime tree; the
  // backend resolves it with the same variable, so install and lookup
  // always agree.
  const runtimeRoot = process.env.PI_CAD_SU2_RUNTIME
    ? PathResolve(process.env.PI_CAD_SU2_RUNTIME)
    : join(root, ".runtime", "su2");
  const targetDir = join(runtimeRoot, version, key, "bin");
  const binaryName = key.startsWith("win32") ? "SU2_CFD.exe" : "SU2_CFD";
  const target = join(targetDir, binaryName);
  if (existsSync(target)) {
    console.log(`[pi-cad] SU2 ${version} already installed (${key})`);
    return { status: "ready", target };
  }
  const tmpDir = join(runtimeRoot, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const zipPath = join(tmpDir, `su2-${version}-${key}.zip`);
  try {
    console.log(`[pi-cad] downloading SU2 ${version} for ${key}...`);
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    const digest = sha256File(zipPath);
    if (digest !== entry.sha256) {
      throw new Error(`sha256 mismatch: expected ${entry.sha256}, got ${digest}`);
    }
    mkdirSync(targetDir, { recursive: true });
    pythonExtract(python, env, root, zipPath, entry.binary ?? `bin/${binaryName}`, target);
    chmodSync(target, 0o755);
    const check = execFileSync(target, ["--help"], { encoding: "utf-8", env: { ...env, OMP_NUM_THREADS: "1" } });
    if (!/SU2 v/.test(check)) throw new Error("binary did not identify as SU2");
    console.log(`[pi-cad] SU2 ${version} installed: ${target}`);
    return { status: "ready", target };
  } catch (error) {
    try {
      if (existsSync(target)) rmSync(target);
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    console.warn(`[pi-cad] SU2 install unavailable; flow/thermal simulation disabled (${String(error?.message ?? error)})`);
    return { status: "unavailable" };
  } finally {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// Direct execution: node scripts/install-su2.mjs
if (process.argv[1] && process.argv[1].endsWith("install-su2.mjs")) {
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const venvPython = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");
  const python = existsSync(venvPython)
    ? venvPython
    : process.platform === "win32" ? "py" : "python3";
  const result = await installSu2({ root, python });
  process.exit(result.status === "ready" || result.status === "skipped" || result.status === "external" ? 0 : 0);
}
