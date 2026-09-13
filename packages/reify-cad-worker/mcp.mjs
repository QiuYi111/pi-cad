#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath as realpathNative } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const entry = await resolveWindowsEntry();

if (process.platform !== "win32") {
  const { serveMcp } = await import("./src/server.mjs");
  await serveMcp();
} else {
  await proxyToWsl();
}

async function resolveWindowsEntry() {
  const value = process.argv[1] || fileURLToPath(import.meta.url);
  try {
    const native = await realpathNative(value);
    const unc = native.match(/^\\\\\\?\\UNC\\([^\\]+\\[^\\]+)(?:\\(.*))?$/i);
    if (unc) return `\\\\${unc[1]}\\${unc[2] || ""}`.replace(/\\$/, "");
  } catch {}
  const mapped = value.match(/^([A-Za-z]):\\(.*)$/);
  if (!mapped) return value;
  const cwd = process.cwd();
  if (/^\\\\wsl(\.localhost|\$)\\/i.test(cwd)) {
    return `\\\\wsl.localhost\\${process.env.REIFY_WSL_DISTRO || "Ubuntu"}\\${mapped[2]}`;
  }
  try {
    const { stdout } = await execFileAsync("net", ["use", `${mapped[1]}:`]);
    const remote = stdout.match(/\\\\[^\r\n]+/);
    if (remote) return `${remote[0].replace(/[\r\n]+$/, "")}\\${mapped[2]}`;
  } catch {}
  return value;
}

async function wslPath(distro, windowsPath) {
  const { stdout } = await execFileAsync("wsl.exe", ["-d", distro, "--exec", "wslpath", "-a", "-u", windowsPath]);
  const value = stdout.trim();
  if (!value.startsWith("/")) throw new Error(`Could not convert the MCP entry to a WSL path: ${windowsPath}`);
  return value;
}

async function proxyToWsl() {
  const distro = process.env.REIFY_WSL_DISTRO || "Ubuntu";
  const wslEntry = process.env.REIFY_WORKER_WSL_ENTRY || (await wslPath(distro, entry));
  const node = process.env.REIFY_WORKER_WSL_NODE || (process.env.REIFY_WSL_NODE ? quote(process.env.REIFY_WSL_NODE) : '"$(command -v node)"');
  const runtimeRepo = process.env.REIFY_PI_CAD_REPO ? `export REIFY_PI_CAD_REPO=${quote(process.env.REIFY_PI_CAD_REPO)};` : "";
  const runtimePrime = process.env.PRIME_AGENT_REPO ? `export PRIME_AGENT_REPO=${quote(process.env.PRIME_AGENT_REPO)};` : "";
  const runtimeAgent = process.env.PRIME_AGENT_CODING_AGENT_DIR ? `export PRIME_AGENT_CODING_AGENT_DIR=${quote(process.env.PRIME_AGENT_CODING_AGENT_DIR)};` : "";
  const shell = [
    "set -eu",
    runtimeRepo, runtimePrime, runtimeAgent,
    `export REIFY_CALLER_HOST=windows;`,
    `export REIFY_WSL_DISTRO=${quote(distro)};`,
    `exec ${node} ${quote(wslEntry)}`,
  ].filter(Boolean).join(" ");
  const child = spawn("wsl.exe", ["-d", distro, "--", "/bin/bash", "-l", "-c", shell], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(chunk.includes("\n") ? chunk : `${chunk}\n`));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let requestQueue = Promise.resolve();
  input.on("line", (line) => {
    requestQueue = requestQueue.then(async () => child.stdin.write(`${await adaptRequest(distro, line)}\n`)).catch((error) => process.stderr.write(`${error?.stack || error}\n`));
  });
  process.stdin.once("end", () => { requestQueue.then(() => child.stdin.end()).catch(() => child.stdin.end()); });
  child.stdout.pipe(process.stdout);
  child.once("exit", (code, signal) => process.exitCode = signal ? 1 : code ?? 1);
}

async function adaptRequest(distro, line) {
  try {
    const request = JSON.parse(line);
    const cwd = request?.params?.arguments?.cwd;
    if (typeof cwd === "string" && (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\"))) {
      request.params.arguments.cwd = await wslPath(distro, cwd);
    }
    return JSON.stringify(request);
  } catch {
    return line;
  }
}

function quote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
