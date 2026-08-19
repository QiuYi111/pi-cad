#!/usr/bin/env node
/**
 * Optional Blender runtime installer for Pi-CAD.
 *
 * Release presentation is an optional capability: a failed download must
 * never break `npm install`. PI_CAD_SKIP_BLENDER=1 opts out entirely;
 * PI_CAD_BLENDER_BIN bypasses the managed runtime with an external binary;
 * a blender already on PATH always wins (the backend resolves PATH first).
 *
 * Layout: .runtime/blender/<version>/<platform>/blender
 * The manifest pins the official release URL and its SHA256. Entries whose
 * sha256 is "pending-download-verification" are treated as unpinned and
 * skipped: an unpinned download is worse than no download.
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

function pythonExtract(python, env, root, archivePath, member, destPath) {
  // tar.xz extraction (and dmg absence) via the Python runtime guaranteed
  // by postinstall; Node has no built-in archive reader.
  const script =
    "import sys, tarfile, os\n" +
    "archive = tarfile.open(sys.argv[1])\n" +
    "member = archive.extractfile(sys.argv[2])\n" +
    "if member is None:\n" +
    "    raise SystemExit('member is not a file: ' + sys.argv[2])\n" +
    "os.makedirs(os.path.dirname(sys.argv[3]), exist_ok=True)\n" +
    "open(sys.argv[3], 'wb').write(member.read())\n";
  execFileSync(python, ["-c", script, archivePath, member, destPath], { cwd: root, env, stdio: "pipe" });
}

export async function installBlender({ root, python, env = process.env }) {
  if (process.env.PI_CAD_SKIP_BLENDER) {
    console.log("[pi-cad] PI_CAD_SKIP_BLENDER set; skipping Blender install (release presentation limited to PATH blender)");
    return { status: "skipped" };
  }
  if (process.env.PI_CAD_BLENDER_BIN) {
    console.log("[pi-cad] PI_CAD_BLENDER_BIN set; using external Blender binary");
    return { status: "external" };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "scripts", "blender-manifest.json"), "utf-8"));
  } catch {
    console.warn("[pi-cad] Blender manifest unreadable; release presentation relies on PATH blender");
    return { status: "unavailable" };
  }
  const key = platformKey();
  const entry = key && manifest.platforms?.[key];
  if (!entry || !entry.binary) {
    console.warn(`[pi-cad] no Blender archive for platform ${key ?? process.platform}; release presentation relies on PATH blender`);
    return { status: "unavailable" };
  }
  if (!entry.sha256 || entry.sha256 === "pending-download-verification") {
    console.warn("[pi-cad] Blender archive hash not pinned yet; refusing unpinned download (release presentation relies on PATH blender)");
    return { status: "unpinned" };
  }
  const version = manifest.version ?? "unknown";
  const runtimeRoot = process.env.PI_CAD_BLENDER_RUNTIME
    ? PathResolve(process.env.PI_CAD_BLENDER_RUNTIME)
    : join(root, ".runtime", "blender");
  const targetDir = join(runtimeRoot, version, key);
  const target = join(targetDir, "blender");
  if (existsSync(target)) {
    console.log(`[pi-cad] Blender ${version} already installed (${key})`);
    return { status: "ready", target };
  }
  const tmpDir = join(runtimeRoot, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, `blender-${version}-${key}.archive`);
  try {
    console.log(`[pi-cad] downloading Blender ${version} for ${key}...`);
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
    const digest = sha256File(archivePath);
    if (digest !== entry.sha256) {
      throw new Error(`sha256 mismatch: expected ${entry.sha256}, got ${digest}`);
    }
    mkdirSync(targetDir, { recursive: true });
    pythonExtract(python, env, root, archivePath, entry.binary, target);
    chmodSync(target, 0o755);
    const check = execFileSync(target, ["--version"], { encoding: "utf-8", env: { ...env, OMP_NUM_THREADS: "1" } });
    if (!/Blender \d/.test(check)) throw new Error("binary did not identify as Blender");
    console.log(`[pi-cad] Blender ${version} installed: ${target}`);
    return { status: "ready", target };
  } catch (error) {
    try {
      if (existsSync(target)) rmSync(target);
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    console.warn(`[pi-cad] Blender install unavailable; release presentation relies on PATH blender (${String(error?.message ?? error)})`);
    return { status: "unavailable" };
  } finally {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// Direct execution: node scripts/install-blender.mjs
if (process.argv[1] && process.argv[1].endsWith("install-blender.mjs")) {
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const venvPython = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");
  const python = existsSync(venvPython)
    ? venvPython
    : process.platform === "win32" ? "py" : "python3";
  const result = await installBlender({ root, python });
  process.exit(result.status === "ready" || result.status === "skipped" || result.status === "external" ? 0 : 0);
}
