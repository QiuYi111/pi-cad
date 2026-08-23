import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeIdentity, SimulationCommandResult, SimulationCommandRunner } from "./store.ts";

export interface RuntimeRegistration {
  backend: string;
  runtime: string;
  launcher: "bubblewrap";
  package: string;
  resolvedPackageVersion: string;
  root: string;
  network: "none";
  limits: { cpu: number; memoryGiB: number; tasks: number; wallHours: number; workspaceGiB: number };
}

let registrations: Promise<RuntimeRegistration[]> | undefined;
async function runtimeRegistration(backend: string, runtime: string): Promise<RuntimeRegistration> {
  registrations ??= readFile(fileURLToPath(new URL("../../../assets/simulation-runtimes.json", import.meta.url)), "utf-8")
    .then((text) => JSON.parse(text) as { schema: number; runtimes: RuntimeRegistration[] })
    .then((registry) => {
      if (registry.schema !== 1 || !Array.isArray(registry.runtimes)) throw new Error("invalid simulation runtime registry");
      return registry.runtimes;
    });
  const found = (await registrations).find((entry) => entry.backend === backend && entry.runtime === runtime);
  if (!found) throw new Error(`unknown simulation backend/runtime: ${backend}/${runtime}`);
  return found;
}

export async function simulationRuntimeProjection(): Promise<Array<{ backend: string; runtime: string }>> {
  registrations ??= readFile(fileURLToPath(new URL("../../../assets/simulation-runtimes.json", import.meta.url)), "utf-8")
    .then((text) => JSON.parse(text) as { schema: number; runtimes: RuntimeRegistration[] })
    .then((registry) => {
      if (registry.schema !== 1 || !Array.isArray(registry.runtimes)) throw new Error("invalid simulation runtime registry");
      return registry.runtimes;
    });
  return (await registrations).map(({ backend, runtime }) => ({ backend, runtime }));
}

function commandOutput(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const safeCwd = process.platform === "win32" && command.toLowerCase().includes("wsl") ? (process.env.SystemRoot ?? "C:\\Windows") : cwd;
    const env = process.platform === "win32" && command.toLowerCase().includes("wsl")
      ? Object.fromEntries(Object.entries(process.env).map(([key, value]) => key.toLowerCase() === "path" ? [key, (value ?? "").split(";").filter((entry) => !/^V:[\\/]/i.test(entry) && !/^\\\\wsl(?:\.localhost)?\\/i.test(entry)).join(";")] : [key, value]))
      : process.env;
    const child = spawn(command, args, { cwd: safeCwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(Buffer.concat(stdout).toString("utf-8").trim()) : reject(new Error(Buffer.concat(stderr).toString("utf-8").trim() || `${command} exited ${code}`)));
  });
}

async function linuxPath(path: string, cwd: string): Promise<string> {
  if (process.platform !== "win32") return path;
  const unc = path.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.*)$/i);
  if (unc?.[1] === (process.env.PI_CAD_WSL_DISTRO ?? "Ubuntu")) return `/${unc[2].replaceAll("\\", "/")}`;
  const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) {
    const displayRoot = await commandOutput("powershell.exe", ["-NoProfile", "-Command", `(Get-PSDrive -Name '${drive[1]}').DisplayRoot`], process.env.SystemRoot ?? "C:\\Windows").catch(() => "");
    const match = displayRoot.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)$/i);
    if (match?.[1] === (process.env.PI_CAD_WSL_DISTRO ?? "Ubuntu")) return `/${drive[2].replaceAll("\\", "/")}`;
  }
  return commandOutput("wsl.exe", ["-d", process.env.PI_CAD_WSL_DISTRO ?? "Ubuntu", "--", "wslpath", "-a", path.replaceAll("\\", "/")], cwd);
}

export function boundedFailure(stderr: string, stdout: string): string[] {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).filter(Boolean);
  const fatal = lines.findIndex((line) => /fatal|error|exception|killed|timeout/i.test(line));
  const start = fatal >= 0 ? Math.max(0, fatal - 8) : Math.max(0, lines.length - 40);
  return lines.slice(start, start + 40).join("\n").slice(0, 8192).split("\n");
}

export function classifyResourceFailure(stderr: string, stdout = ""): string | undefined {
  const text = `${stderr}\n${stdout}`;
  if (/oom[-_ ]?kill|out of memory|memory(?:max)?[^\n]*(?:exceeded|limit)|cannot allocate memory/i.test(text)) return "memory limit exceeded";
  if (/tasksmax|pids?[^\n]*(?:exceeded|limit)|resource temporarily unavailable|cannot fork/i.test(text)) return "task/PID limit exceeded";
  return undefined;
}

export function managedLimitProperties(limits: RuntimeRegistration["limits"]): string[] {
  return [
    `CPUQuota=${limits.cpu * 100}%`,
    `MemoryMax=${limits.memoryGiB}G`,
    `TasksMax=${limits.tasks}`,
    `RuntimeMaxSec=${limits.wallHours}h`,
  ];
}

export async function spawnLogged(input: {
  command: string;
  args: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  workspaceLimit?: { path: string; maxBytes: number };
  quotaPollMs?: number;
}): Promise<SimulationCommandResult> {
  await mkdir(dirname(input.stdoutPath), { recursive: true });
  const stdoutFile = createWriteStream(input.stdoutPath);
  const stderrFile = createWriteStream(input.stderrPath);
  const capturedOut: Buffer[] = []; const capturedErr: Buffer[] = [];
  const capture = (target: Buffer[], chunk: Buffer) => {
    target.push(Buffer.from(chunk));
    let total = target.reduce((sum, item) => sum + item.length, 0);
    while (total > 1024 * 1024 && target.length > 1) total -= target.shift()!.length;
  };
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let quotaExceeded = false;
    let quotaCheckRunning = false;
    const treeSize = async (path: string): Promise<number> => {
      const info = await lstat(path);
      if (!info.isDirectory()) return info.size;
      let total = 0;
      for (const name of await readdir(path)) total += await treeSize(resolve(path, name));
      return total;
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs);
    const quotaTimer = input.workspaceLimit ? setInterval(async () => {
      if (quotaCheckRunning) return;
      quotaCheckRunning = true;
      try {
        if (await treeSize(input.workspaceLimit!.path) > input.workspaceLimit!.maxBytes) {
          quotaExceeded = true;
          child.kill("SIGKILL");
        }
      } catch {
        // A concurrent solver rename can make a traversal transiently stale;
        // the next bounded interval rechecks the complete tree.
      } finally {
        quotaCheckRunning = false;
      }
    }, input.quotaPollMs ?? 5000) : undefined;
    child.stdout.on("data", (chunk) => { stdoutFile.write(chunk); capture(capturedOut, chunk); });
    child.stderr.on("data", (chunk) => { stderrFile.write(chunk); capture(capturedErr, chunk); });
    child.on("error", (error) => { clearTimeout(timer); if (quotaTimer) clearInterval(quotaTimer); stdoutFile.end(); stderrFile.end(); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer); if (quotaTimer) clearInterval(quotaTimer); stdoutFile.end(); stderrFile.end();
      const stdout = Buffer.concat(capturedOut).toString("utf-8");
      const stderr = Buffer.concat(capturedErr).toString("utf-8");
      const classified = classifyResourceFailure(stderr, stdout);
      const failure = quotaExceeded
        ? `workspace quota exceeded\n${stderr}`
        : timedOut
          ? `timeout after ${input.timeoutMs}ms\n${stderr}`
          : classified
            ? `${classified}\n${stderr}`
            : stderr;
      resolvePromise({ exitCode: quotaExceeded ? 122 : timedOut ? 124 : code ?? 1, durationMs: Date.now() - started, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192), diagnostics: boundedFailure(failure, stdout) });
    });
  });
}

export class LocalSimulationRunner implements SimulationCommandRunner {
  async resolveRuntime(_cwd: string, backend: string, runtime: string): Promise<RuntimeIdentity> {
    return { backend, runtime, platform: `${process.platform}-${process.arch}`, resolvedVersion: process.version, digest: createHash("sha256").update(`${backend}\0${runtime}\0${process.version}`).digest("hex"), launcher: "local-test" };
  }

  async execute(input: Parameters<SimulationCommandRunner["execute"]>[0]): Promise<SimulationCommandResult> {
    const env = { ...process.env, ...input.environment };
    await mkdir(dirname(input.stdoutPath), { recursive: true });
    const command = process.platform === "win32" ? "bash.exe" : "/bin/bash";
    return spawnLogged({ command, args: ["-lc", input.command], cwd: input.recipeDirectory, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs, env });
  }
}

export class ManagedSimulationRunner implements SimulationCommandRunner {
  private readonly identities = new Map<string, RuntimeIdentity>();

  async resolveRuntime(cwd: string, backend: string, runtime: string): Promise<RuntimeIdentity> {
    const registration = await runtimeRegistration(backend, runtime);
    const key = `${backend}/${runtime}`;
    const cached = this.identities.get(key);
    if (cached) return cached;
    const distro = process.env.PI_CAD_WSL_DISTRO ?? "Ubuntu";
    const linux = (command: string, args: string[]) => process.platform === "win32"
      ? commandOutput("wsl.exe", ["-d", distro, "--", command, ...args], cwd)
      : commandOutput(command, args, cwd);
    await linux("test", ["-x", "/usr/bin/bwrap"]);
    await linux("test", ["-f", `${registration.root}/etc/bashrc`]);
    const resolvedVersion = await linux("dpkg-query", ["-W", "-f=\\${Version}", registration.package]);
    if (!resolvedVersion.includes(registration.resolvedPackageVersion)) throw new Error(`unexpected ${registration.package} version: ${resolvedVersion}`);
    const arch = await linux("uname", ["-m"]);
    const launcherVersion = await linux("bwrap", ["--version"]);
    const hashScript = `set -e; { dpkg-query -L ${registration.package}; find /opt/pi-cad-runtime/python -type f -print; } | sort -u | while IFS= read -r f; do test -f "$f" && sha256sum "$f" || true; done | sha256sum | cut -d' ' -f1`;
    const executableHash = process.platform === "win32"
      ? await linux("bash", ["-lc", `echo ${Buffer.from(hashScript).toString("base64")}|base64 -d|bash`])
      : await linux("bash", ["-lc", hashScript]);
    const environment = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", network: registration.network };
    const payload = { backend, runtime, resolvedVersion, arch, installedFilesHash: executableHash, launcherVersion, environment };
    const identity = { backend, runtime, platform: `linux-${arch}`, resolvedVersion, digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), launcher: `bubblewrap/${launcherVersion}` };
    this.identities.set(key, identity);
    return identity;
  }

  async execute(input: Parameters<SimulationCommandRunner["execute"]>[0]): Promise<SimulationCommandResult> {
    const registration = await runtimeRegistration(input.backend, input.runtime);
    const workspace = await linuxPath(resolve(input.workspace), input.cwd);
    const recipeRel = relative(resolve(input.workspace), resolve(input.recipeDirectory)).split(sep).join("/");
    if (recipeRel.startsWith("..")) throw new Error("recipe directory escapes managed workspace");
    const bwrap = [
      "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", registration.root, registration.root,
      "--ro-bind", "/opt/pi-cad-runtime", "/opt/pi-cad-runtime",
      "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache", "--ro-bind", "/etc/passwd", "/etc/passwd", "--ro-bind", "/etc/group", "/etc/group",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
      "--bind", workspace, "/workspace", "--chdir", `/workspace/${recipeRel}`,
      "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "LC_ALL", "C.UTF-8",
    ];
    const hostWorkspace = resolve(input.workspace);
    for (const [key, value] of Object.entries(input.environment)) {
      const absoluteValue = isAbsolute(value) ? resolve(value) : "";
      const rel = absoluteValue ? relative(hostWorkspace, absoluteValue) : "..";
      const mapped = absoluteValue && !rel.startsWith("..") && !rel.includes(`..${sep}`) && rel !== ".."
        ? `/workspace/${rel.split(sep).join("/")}`
        : value.replaceAll(workspace, "/workspace");
      bwrap.push("--setenv", key, mapped);
    }
    bwrap.push("/bin/bash", "-lc", `. ${registration.root}/etc/bashrc >/dev/null 2>&1 && ${input.command}`);
    const scope = ["--user", "--scope", "--quiet", ...managedLimitProperties(registration.limits).flatMap((property) => ["-p", property]), "bwrap", ...bwrap];
    const command = process.platform === "win32" ? "wsl.exe" : "systemd-run";
    const args = process.platform === "win32" ? ["-d", process.env.PI_CAD_WSL_DISTRO ?? "Ubuntu", "--", "systemd-run", ...scope] : scope;
    return spawnLogged({ command, args, cwd: process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : input.cwd, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs, workspaceLimit: { path: input.workspace, maxBytes: registration.limits.workspaceGiB * 1024 ** 3 } });
  }
}

export const managedSimulationRunner = new ManagedSimulationRunner();
