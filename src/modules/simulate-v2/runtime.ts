import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeIdentity, SimulationCommandResult, SimulationCommandRunner } from "./store.ts";
import { assertLinuxRuntime } from "../../shared/platform.ts";
import { runProcess } from "../../shared/process-runner.ts";
import { harnessStorageRoot } from "../../authority/storage.ts";

interface RuntimeRegistrationBase {
  backend: string;
  runtime: string;
  kind: "apt" | "uv" | "archive";
  launcher: "bubblewrap";
  bootstrap: string;
  network: "none";
  immutableRoots: string[];
  expectedVersion: string;
  activation?: string;
  environment: Record<string, string>;
  accelerator: "none" | "cpu" | "cuda";
  developmentOnly?: boolean;
  limits: { cpu: number; memoryGiB: number; tasks: number; wallHours: number; workspaceGiB: number };
  agentCapabilities: {
    pythonCommand: string;
    executables: string[];
    pythonModules: string[];
    sandbox: "bubblewrap";
    network: "none";
    accelerator: "none" | "cpu" | "cuda";
    cookbookTemplateId: string;
  };
}

interface RuntimeProbeRegistration {
  script: string;
  args: string[];
  expected: Record<string, string | number | boolean>;
}

export type RuntimeRegistration = RuntimeRegistrationBase & (
  | { kind: "apt"; package: string }
  | { kind: "uv"; pythonProject: string; probe: RuntimeProbeRegistration }
  | { kind: "archive"; executable: string; versionArgument: string; archiveUrl: string; sha256: string }
);

const COMMON_RUNTIME_KEYS = new Set([
  "backend", "runtime", "kind", "launcher", "bootstrap", "network", "immutableRoots",
  "expectedVersion", "activation", "environment", "accelerator", "developmentOnly", "limits",
  "agentCapabilities",
]);
const KIND_RUNTIME_KEYS: Record<RuntimeRegistration["kind"], Set<string>> = {
  apt: new Set(["package"]),
  uv: new Set(["pythonProject", "probe"]),
  archive: new Set(["executable", "versionArgument", "archiveUrl", "sha256"]),
};

export function validateRuntimeRegistry(value: unknown): RuntimeRegistration[] {
  const registry = value as { schema?: unknown; runtimes?: unknown };
  if (registry?.schema !== 2 || !Array.isArray(registry.runtimes)) throw new Error("invalid simulation runtime registry schema");
  const seen = new Set<string>();
  return registry.runtimes.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid runtime registration at index ${index}`);
    const entry = raw as Record<string, unknown>;
    if (!KIND_RUNTIME_KEYS[entry.kind as RuntimeRegistration["kind"]]) throw new Error(`invalid runtime kind at index ${index}`);
    const allowed = new Set([...COMMON_RUNTIME_KEYS, ...KIND_RUNTIME_KEYS[entry.kind as RuntimeRegistration["kind"]]]);
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`unknown runtime registration fields at index ${index}: ${unknown.join(", ")}`);
    for (const key of ["backend", "runtime", "bootstrap", "expectedVersion"] as const) {
      if (typeof entry[key] !== "string" || !entry[key]) throw new Error(`runtime ${index} requires ${key}`);
    }
    if (entry.launcher !== "bubblewrap" || entry.network !== "none") throw new Error(`runtime ${index} must use bubblewrap with network=none`);
    if (!Array.isArray(entry.immutableRoots) || !entry.immutableRoots.length || entry.immutableRoots.some((root) => typeof root !== "string" || !root.startsWith("/"))) {
      throw new Error(`runtime ${index} requires absolute immutableRoots`);
    }
    if (!entry.environment || typeof entry.environment !== "object" || Array.isArray(entry.environment)) throw new Error(`runtime ${index} requires environment`);
    if (!new Set(["none", "cpu", "cuda"]).has(String(entry.accelerator))) throw new Error(`runtime ${index} has invalid accelerator`);
    const limits = entry.limits as Record<string, unknown> | undefined;
    if (!limits || ["cpu", "memoryGiB", "tasks", "wallHours", "workspaceGiB"].some((key) => typeof limits[key] !== "number" || Number(limits[key]) <= 0)) {
      throw new Error(`runtime ${index} has invalid limits`);
    }
    const capabilities = entry.agentCapabilities as Record<string, unknown> | undefined;
    if (!capabilities || Object.keys(capabilities).some((key) => !["pythonCommand", "executables", "pythonModules", "sandbox", "network", "accelerator", "cookbookTemplateId"].includes(key))) {
      throw new Error(`runtime ${index} requires strict agentCapabilities`);
    }
    if (capabilities.pythonCommand !== 'uv run --offline --frozen --project "$PI_CAD_PYTHON_PROJECT" python') throw new Error(`runtime ${index} must advertise the locked Recipe Python command`);
    if (!Array.isArray(capabilities.executables) || capabilities.executables.some((item) => typeof item !== "string")
      || !Array.isArray(capabilities.pythonModules) || capabilities.pythonModules.some((item) => typeof item !== "string")
      || capabilities.sandbox !== "bubblewrap" || capabilities.network !== "none"
      || capabilities.accelerator !== entry.accelerator
      || typeof capabilities.cookbookTemplateId !== "string" || !capabilities.cookbookTemplateId) {
      throw new Error(`runtime ${index} has invalid agentCapabilities`);
    }
    const registration = entry as unknown as RuntimeRegistration;
    if (registration.kind === "apt" && typeof registration.package !== "string") throw new Error(`apt runtime ${index} requires package`);
    if (registration.kind === "uv") {
      if (typeof registration.pythonProject !== "string" || !registration.pythonProject.startsWith("/opt/")) throw new Error(`uv runtime ${index} requires an /opt pythonProject`);
      const probe = registration.probe as unknown as Record<string, unknown> | undefined;
      if (!probe || Object.keys(probe).some((key) => !["script", "args", "expected"].includes(key))) throw new Error(`uv runtime ${index} requires a strict probe declaration`);
      if (typeof probe.script !== "string" || !/^scripts\/[A-Za-z0-9_.-]+\.py$/.test(probe.script)) throw new Error(`uv runtime ${index} probe requires a packaged Python script`);
      if (!Array.isArray(probe.args) || probe.args.some((arg) => typeof arg !== "string")) throw new Error(`uv runtime ${index} probe args must be strings`);
      if (!probe.expected || typeof probe.expected !== "object" || Array.isArray(probe.expected) || Object.values(probe.expected).some((item) => !["string", "number", "boolean"].includes(typeof item))) {
        throw new Error(`uv runtime ${index} probe expected projection must contain scalar values`);
      }
    }
    if (registration.kind === "archive" && (
      typeof registration.executable !== "string" || !registration.executable.startsWith("/opt/")
      || typeof registration.versionArgument !== "string"
      || typeof registration.archiveUrl !== "string" || !registration.archiveUrl.startsWith("https://")
      || typeof registration.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(registration.sha256)
    )) throw new Error(`archive runtime ${index} requires executable/versionArgument/archiveUrl/sha256`);
    const identity = `${registration.backend}/${registration.runtime}`;
    if (seen.has(identity)) throw new Error(`duplicate simulation runtime: ${identity}`);
    seen.add(identity);
    return registration;
  });
}

let registrations: Promise<RuntimeRegistration[]> | undefined;
async function runtimeRegistration(backend: string, runtime: string): Promise<RuntimeRegistration> {
  registrations ??= readFile(fileURLToPath(new URL("../../../assets/simulation-runtimes.json", import.meta.url)), "utf-8")
    .then((text) => validateRuntimeRegistry(JSON.parse(text)));
  const found = (await registrations).find((entry) => entry.backend === backend && entry.runtime === runtime);
  if (!found) throw new Error(`unknown simulation backend/runtime: ${backend}/${runtime}`);
  return found;
}

interface RuntimeAvailabilityManifest {
  schema: 1;
  status: "ready";
  backend: string;
  runtime: string;
  registryHash: string;
  qualifiedAt: string;
  identity: RuntimeIdentity;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function registrationHash(registration: RuntimeRegistration): string {
  return createHash("sha256").update(canonical(registration)).digest("hex");
}

function availabilityPath(cwd: string, backend: string, runtime: string): string {
  const name = createHash("sha256").update(`${backend}\0${runtime}`).digest("hex");
  return resolve(harnessStorageRoot(cwd), "cache", "runtimes", `${name}.json`);
}

export async function readRuntimeAvailability(
  cwd: string,
  backend: string,
  runtime: string,
): Promise<RuntimeAvailabilityManifest | null> {
  const registration = await runtimeRegistration(backend, runtime);
  try {
    const parsed = JSON.parse(await readFile(availabilityPath(cwd, backend, runtime), "utf-8")) as RuntimeAvailabilityManifest;
    if (
      parsed.schema !== 1 || parsed.status !== "ready" || parsed.backend !== backend || parsed.runtime !== runtime
      || parsed.registryHash !== registrationHash(registration)
      || parsed.identity.backend !== backend || parsed.identity.runtime !== runtime
      || !/^[a-f0-9]{64}$/.test(parsed.identity.digest)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRuntimeAvailability(
  cwd: string,
  registration: RuntimeRegistration,
  identity: RuntimeIdentity,
): Promise<void> {
  const path = availabilityPath(cwd, registration.backend, registration.runtime);
  await mkdir(dirname(path), { recursive: true });
  const manifest: RuntimeAvailabilityManifest = {
    schema: 1,
    status: "ready",
    backend: registration.backend,
    runtime: registration.runtime,
    registryHash: registrationHash(registration),
    qualifiedAt: new Date().toISOString(),
    identity,
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await rename(temporary, path);
}

export async function simulationRuntimeProjection(): Promise<Array<{
  backend: string;
  runtime: string;
  kind: RuntimeRegistration["kind"];
  developmentOnly?: boolean;
  limits: RuntimeRegistration["limits"];
  agentCapabilities: RuntimeRegistration["agentCapabilities"];
}>> {
  registrations ??= readFile(fileURLToPath(new URL("../../../assets/simulation-runtimes.json", import.meta.url)), "utf-8")
    .then((text) => validateRuntimeRegistry(JSON.parse(text)));
  return (await registrations).map(({ backend, runtime, kind, developmentOnly, limits, agentCapabilities }) => ({ backend, runtime, kind, limits, agentCapabilities, ...(developmentOnly ? { developmentOnly } : {}) }));
}

async function commandOutput(command: string, args: string[], cwd: string): Promise<string> {
  assertLinuxRuntime("Pi-CAD managed runtime");
  const result = await runProcess({
    command,
    args,
    cwd,
    env: process.env,
    timeoutMs: 30_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 256 * 1024,
  });
  if (result.exitCode !== 0 || result.terminationReason !== "exit") {
    throw new Error(result.stderr.trim() || `${command} exited ${result.exitCode}`);
  }
  return result.stdout.trim();
}

async function linuxPath(path: string, cwd: string): Promise<string> {
  void cwd;
  assertLinuxRuntime("Pi-CAD managed runtime");
  return path;
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
  signal?: AbortSignal;
  workspaceLimit?: { path: string; maxBytes: number };
  quotaPollMs?: number;
}): Promise<SimulationCommandResult> {
  const treeSize = async (path: string): Promise<number> => {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await treeSize(resolve(path, name));
    return total;
  };
  const result = await runProcess({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    stdoutPath: input.stdoutPath,
    stderrPath: input.stderrPath,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    poll: input.workspaceLimit ? {
      intervalMs: input.quotaPollMs ?? 5000,
      check: async () => {
        try {
          return await treeSize(input.workspaceLimit!.path) > input.workspaceLimit!.maxBytes
            ? "workspace quota exceeded"
            : null;
        } catch {
          // Solvers commonly rename files while a traversal is in progress.
          // A transient miss is rechecked on the next bounded interval.
          return null;
        }
      },
    } : undefined,
  });
  const classified = classifyResourceFailure(result.stderr, result.stdout);
  const failure = result.terminationReason === "poll"
    ? `${result.terminationDetail ?? "workspace quota exceeded"}\n${result.stderr}`
    : result.terminationReason === "timeout"
      ? `timeout after ${input.timeoutMs}ms\n${result.stderr}`
      : result.terminationReason === "aborted"
        ? `aborted\n${result.stderr}`
        : classified
          ? `${classified}\n${result.stderr}`
          : result.stderr;
  return {
    exitCode: result.terminationReason === "poll" ? 122
      : result.terminationReason === "timeout" ? 124
        : result.terminationReason === "aborted" ? 130
          : result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout.slice(-8192),
    stderr: result.stderr.slice(-8192),
    diagnostics: boundedFailure(failure, result.stdout),
  };
}

export class LocalSimulationRunner implements SimulationCommandRunner {
  async resolveRuntime(_cwd: string, backend: string, runtime: string): Promise<RuntimeIdentity> {
    return { backend, runtime, platform: `${process.platform}-${process.arch}`, resolvedVersion: process.version, digest: createHash("sha256").update(`${backend}\0${runtime}\0${process.version}`).digest("hex"), launcher: "local-test" };
  }

  async execute(input: Parameters<SimulationCommandRunner["execute"]>[0]): Promise<SimulationCommandResult> {
    assertLinuxRuntime("Pi-CAD local simulation runtime");
    const env = { ...process.env, ...input.environment };
    await mkdir(dirname(input.stdoutPath), { recursive: true });
    return spawnLogged({ command: "/bin/bash", args: ["-lc", input.command], cwd: input.recipeDirectory, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs, env });
  }
}

export class ManagedSimulationRunner implements SimulationCommandRunner {
  private readonly identities = new Map<string, RuntimeIdentity>();
  private readonly qualifications = new Map<string, Promise<RuntimeIdentity>>();

  async resolveRuntime(cwd: string, backend: string, runtime: string): Promise<RuntimeIdentity> {
    assertLinuxRuntime("Pi-CAD managed simulation runtime");
    const registration = await runtimeRegistration(backend, runtime);
    const key = `${backend}/${runtime}`;
    const cached = this.identities.get(key);
    if (cached) {
      await writeRuntimeAvailability(cwd, registration, cached);
      return cached;
    }
    if (process.env.PI_CAD_REQUALIFY_RUNTIME !== "1") {
      const persisted = await readRuntimeAvailability(cwd, backend, runtime);
      if (persisted) {
        this.identities.set(key, persisted.identity);
        return persisted.identity;
      }
    }
    const inFlight = this.qualifications.get(key);
    if (inFlight) {
      const identity = await inFlight;
      await writeRuntimeAvailability(cwd, registration, identity);
      return identity;
    }
    const qualification = this.qualifyRuntime(cwd, registration);
    this.qualifications.set(key, qualification);
    try {
      const identity = await qualification;
      this.identities.set(key, identity);
      await writeRuntimeAvailability(cwd, registration, identity);
      return identity;
    } finally {
      this.qualifications.delete(key);
    }
  }

  private async qualifyRuntime(cwd: string, registration: RuntimeRegistration): Promise<RuntimeIdentity> {
    const { backend, runtime } = registration;
    const linux = (command: string, args: string[]) => commandOutput(command, args, cwd);
    await linux("test", ["-x", "/usr/bin/bwrap"]);
    for (const root of registration.immutableRoots) await linux("test", ["-e", root]);
    let resolvedVersion: string;
    let accelerator: Record<string, unknown> | undefined;
    if (registration.kind === "apt") {
      resolvedVersion = await linux("dpkg-query", ["-W", "-f=\\${Version}", registration.package]);
      if (!resolvedVersion.includes(registration.expectedVersion)) throw new Error(`unexpected ${registration.package} version: ${resolvedVersion}`);
    } else if (registration.kind === "archive") {
      await linux("test", ["-x", registration.executable]);
      const output = await linux(registration.executable, [registration.versionArgument]);
      if (!output.includes(registration.expectedVersion)) throw new Error(`unexpected ${registration.backend} version: ${output.slice(0, 512)}`);
      resolvedVersion = registration.expectedVersion;
    } else {
      const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
      const probeScript = resolve(packageRoot, registration.probe.script);
      const probeRelative = relative(packageRoot, probeScript);
      if (probeRelative.startsWith("..") || isAbsolute(probeRelative)) throw new Error(`runtime probe escapes package root: ${registration.probe.script}`);
      const probeCode = await readFile(probeScript, "utf-8");
      const output = await linux("env", [
        ...Object.entries(registration.environment).map(([key, value]) => `${key}=${value}`),
        "uv", "run", "--offline", "--frozen", "--project", registration.pythonProject,
        "python", "-c", probeCode, ...registration.probe.args,
      ]);
      const payload = output.split(/\r?\n/).filter(Boolean).at(-1);
      if (!payload) throw new Error(`runtime probe ${registration.probe.script} produced no JSON`);
      accelerator = JSON.parse(payload) as Record<string, unknown>;
      for (const [key, expected] of Object.entries(registration.probe.expected)) {
        if (accelerator[key] !== expected) throw new Error(`unexpected ${registration.runtime} probe value ${key}: ${String(accelerator[key])}`);
      }
      if (registration.accelerator === "cuda" && accelerator.actualDevice !== "cuda") throw new Error(`${registration.runtime} requires CUDA; CPU fallback is forbidden`);
      if (registration.accelerator === "cpu" && accelerator.actualDevice !== "cpu") throw new Error(`${registration.runtime} requires explicit CPU execution`);
      resolvedVersion = registration.expectedVersion;
    }
    const arch = await linux("uname", ["-m"]);
    const launcherVersion = await linux("bwrap", ["--version"]);
    const roots = registration.immutableRoots.map((root) => `'${root.replaceAll("'", "'\\''")}'`).join(" ");
    const packageFiles = registration.kind === "apt" ? `dpkg-query -L ${registration.package};` : "";
    const hashScript = `set -e; { ${packageFiles} find ${roots} -type f -print; } | sort -u | while IFS= read -r f; do test -f "$f" && sha256sum "$f" || true; done | sha256sum | cut -d' ' -f1`;
    const executableHash = await linux("bash", ["-lc", hashScript]);
    const environment = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", network: registration.network, ...registration.environment };
    const probeScriptHash = registration.kind === "uv"
      ? createHash("sha256").update(await readFile(fileURLToPath(new URL(`../../../${registration.probe.script}`, import.meta.url)))).digest("hex")
      : undefined;
    const payload = { backend, runtime, resolvedVersion, arch, installedFilesHash: executableHash, launcherVersion, environment, accelerator, registration, probeScriptHash };
    const identity = { backend, runtime, platform: `linux-${arch}`, resolvedVersion, digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), launcher: `bubblewrap/${launcherVersion}`, ...(accelerator ? { accelerator } : {}) };
    return identity;
  }

  async execute(input: Parameters<SimulationCommandRunner["execute"]>[0]): Promise<SimulationCommandResult> {
    assertLinuxRuntime("Pi-CAD managed simulation runtime");
    const registration = await runtimeRegistration(input.backend, input.runtime);
    const workspace = await linuxPath(resolve(input.workspace), input.cwd);
    const recipeRel = relative(resolve(input.workspace), resolve(input.recipeDirectory)).split(sep).join("/");
    if (recipeRel.startsWith("..")) throw new Error("recipe directory escapes managed workspace");
    const bwrap = [
      "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache", "--ro-bind", "/etc/passwd", "/etc/passwd", "--ro-bind", "/etc/group", "/etc/group",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
      "--bind", workspace, "/workspace", "--chdir", `/workspace/${recipeRel}`,
      "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "LC_ALL", "C.UTF-8",
    ];
    for (const root of registration.immutableRoots) bwrap.push("--ro-bind", root, root);
    if (registration.accelerator === "cuda") {
      bwrap.push(
        "--dev-bind-try", "/dev/dxg", "/dev/dxg",
        "--dev-bind-try", "/dev/nvidiactl", "/dev/nvidiactl",
        "--dev-bind-try", "/dev/nvidia-uvm", "/dev/nvidia-uvm",
        "--dev-bind-try", "/dev/nvidia-uvm-tools", "/dev/nvidia-uvm-tools",
        "--dev-bind-try", "/dev/nvidia0", "/dev/nvidia0",
      );
    }
    const hostWorkspace = resolve(input.workspace);
    // Registry paths identify immutable runtime roots and keep their absolute
    // sandbox identity. Per-run values, in contrast, must be remapped into
    // /workspace; otherwise an observer would receive an inaccessible host
    // path and could never write its declared snapshot.
    for (const [key, value] of Object.entries(registration.environment)) bwrap.push("--setenv", key, value);
    for (const [key, value] of Object.entries(input.environment)) {
      const absoluteValue = isAbsolute(value) ? resolve(value) : "";
      const rel = absoluteValue ? relative(hostWorkspace, absoluteValue) : "..";
      const mapped = absoluteValue && !isAbsolute(rel) && !rel.startsWith("..") && !rel.includes(`..${sep}`) && rel !== ".."
        ? `/workspace/${rel.split(sep).join("/")}`
        : value.replaceAll(workspace, "/workspace");
      bwrap.push("--setenv", key, mapped);
    }
    const commandLine = registration.activation ? `${registration.activation} && ${input.command}` : input.command;
    // Keep the command opaque until the inner shell runs with the bwrap
    // environment so managed variables expand only inside the sandbox.
    const encodedCommand = Buffer.from(commandLine, "utf-8").toString("base64");
    bwrap.push("/bin/bash", "-lc", `echo ${encodedCommand}|base64 -d|/bin/bash`);
    const scope = ["--user", "--scope", "--quiet", ...managedLimitProperties(registration.limits).flatMap((property) => ["-p", property]), "bwrap", ...bwrap];
    return spawnLogged({ command: "systemd-run", args: scope, cwd: input.cwd, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs, workspaceLimit: { path: input.workspace, maxBytes: registration.limits.workspaceGiB * 1024 ** 3 } });
  }
}

export const managedSimulationRunner = new ManagedSimulationRunner();
