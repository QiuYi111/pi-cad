import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerError } from "./errors.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function runtimeConfiguration(overrides = {}) {
  const piCadRepo = resolve(overrides.piCadRepo || process.env.REIFY_PI_CAD_REPO || REPO_ROOT);
  const primeAgentRepo = resolve(overrides.primeAgentRepo || process.env.PRIME_AGENT_REPO || configuredPrimeRepo());
  const agentDir = resolve(overrides.primeAgentDir || process.env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), ".prime", "agent"));
  if (!isAbsolute(piCadRepo) || !existsSync(join(piCadRepo, "scripts", "prime-cad-sidecar.mjs"))) {
    throw new WorkerError(`Pi-CAD runtime is missing: ${piCadRepo}`, "runtime_missing");
  }
  if (!isAbsolute(primeAgentRepo) || !existsSync(join(primeAgentRepo, "prime-agent.sh"))) {
    throw new WorkerError(`Prime Agent repository is missing: ${primeAgentRepo}`, "runtime_missing");
  }
  return {
    piCadRepo,
    primeAgentRepo,
    primeAgentDir: agentDir,
    nodePath: overrides.nodePath || process.env.REIFY_NODE || process.execPath,
    permission: overrides.permission || process.env.PI_CAD_DESKTOP_PERMISSION || "workspace",
    callerHost: overrides.callerHost || process.env.REIFY_CALLER_HOST || (process.platform === "win32" ? "windows" : "wsl"),
    wslDistro: overrides.wslDistro || process.env.REIFY_WSL_DISTRO || "Ubuntu",
    model: overrides.model || {
      provider: process.env.REIFY_WORKER_PROVIDER || "openai-codex",
      model: process.env.REIFY_WORKER_MODEL || "gpt-5.6-sol",
      thinking: process.env.REIFY_WORKER_THINKING || "minimal",
    },
  };
}

function configuredPrimeRepo() {
  const path = join(homedir(), ".prime", "agent", "prime-cad.json");
  if (!existsSync(path)) return "";
  try { return String(JSON.parse(readFileSync(path, "utf8")).primeAgentRepo || ""); }
  catch { return ""; }
}

export function runtimePaths(input, callerHost, wslDistro = "Ubuntu") {
  const runtimePath = input.replaceAll("\\", "/");
  const windowsPath = windowsForm(runtimePath, wslDistro);
  return { runtimePath, windowsPath, displayPath: callerHost === "windows" ? windowsPath : runtimePath };
}

function windowsForm(runtimePath, wslDistro) {
  const mounted = runtimePath.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (mounted) return `${mounted[1].toUpperCase()}:/${mounted[2] || ""}`;
  return `\\\\wsl.localhost\\${wslDistro}${runtimePath}`;
}

export function normalizeProjectRoot(value) {
  if (typeof value !== "string" || !value.trim()) throw new WorkerError("cwd must be a non-empty Linux/WSL path", "invalid_argument");
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) throw new WorkerError("cwd must be a Linux/WSL path after host transport conversion", "invalid_argument");
  return resolve(value);
}
