import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { AppSettings, DependencyCheck, RuntimeStatus } from "../../src/shared/contracts.js";
import { engineeringKnowledgeProbe, type RuntimeBridge } from "./runtime-bridge.js";

const execFileAsync = promisify(execFile);

const WSL_RUNTIME_ENV_KEYS = [
  "PI_CAD_CANONICAL_PROJECT_DIR",
  "PI_CAD_EXPERIENCE_ROOT",
  "PI_CAD_DISTILL_COMMAND_JSON",
  "PI_CAD_TRANSCRIPT_ANALYZER_PROJECT",
  "PI_CAD_TRANSCRIPT_ANALYZER_ENV",
  "PI_CAD_TRANSCRIPT_ANALYZER_TIMEOUT_MS",
  "PI_CAD_DISTILL_THRESHOLD_TOKENS",
  "PI_CAD_DISTILL_PRIME_COMMAND",
  "PI_CAD_DISTILL_PROVIDER",
  "PI_CAD_DISTILL_MODEL",
  "PI_CAD_DISTILL_THINKING",
  "PI_CAD_DISTILL_TIMEOUT_MS",
  "PI_CAD_REPLAY_PROVIDER",
  "PI_CAD_REPLAY_MODEL",
  "PI_CAD_REPLAY_THINKING",
  "PI_CAD_REPLAY_JUDGE_PROVIDER",
  "PI_CAD_REPLAY_JUDGE_MODEL",
  "PI_CAD_REPLAY_JUDGE_THINKING",
  "PI_CAD_REPLAY_TIMEOUT_MS",
  "PI_CAD_REPLAY_SUITE_TIMEOUT_MS",
] as const;

export function forwardWslRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const entries = (source.WSLENV || "").split(":").filter(Boolean);
  const present = new Set(entries.map((entry) => entry.split("/")[0]));
  for (const key of WSL_RUNTIME_ENV_KEYS) {
    if (source[key] !== undefined && !present.has(key)) entries.push(key);
  }
  return { ...source, WSLENV: entries.join(":") };
}

export function wslInstallHeartbeat(elapsedMs: number): RuntimeStatus {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return {
    state: "installing",
    checks: [{ id: "wsl", label: "WSL 2 and Ubuntu", status: "installing", detail: "Windows installer is running", installable: true }],
    message: "Windows is downloading and installing Ubuntu. The Windows progress window may stay quiet for several minutes.",
    progress: 0.2,
    elapsedSeconds,
  };
}

export function classifyWslInstallResult(result: { exitCode: number; distroPresent: boolean; distroReady?: boolean }): RuntimeStatus {
  if (result.exitCode !== 0) return { state: "error", checks: [], action: "retry", message: `Windows installer exited with code ${result.exitCode}.` };
  if (!result.distroPresent) return {
    state: "action-required", checks: [], action: "restart-windows", progress: 0.25,
    message: "Windows accepted the installation. Restart Windows, then reopen Pi-CAD.",
  };
  if (!result.distroReady) return {
    state: "action-required", checks: [], action: "initialize-ubuntu", progress: 0.28,
    message: "Ubuntu is installed but not initialized. Open Ubuntu once, finish its first-run setup, then check again.",
  };
  return { state: "checking", checks: [], progress: 0.3, message: "Ubuntu is ready. Checking the engineering runtime…" };
}

export function wslInstallPowerShellCommand(distro: string): string {
  const escaped = distro.replaceAll("'", "''");
  return `$process = Start-Process -FilePath 'wsl.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('--install','--distribution','${escaped}','--no-launch'); exit $process.ExitCode`;
}

function uncWslPath(value: string): { distro: string; path: string } | null {
  const match = value.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.*)$/i);
  if (!match) return null;
  return { distro: match[1]!, path: `/${match[2]!.replaceAll("\\", "/")}` };
}

export class WslBridge implements RuntimeBridge {
  readonly kind = "wsl" as const;
  private homePromise?: Promise<string>;
  constructor(readonly distro: string, readonly bundledRuntimePath?: string) {}

  async exec(args: string[], options: { input?: string; timeout?: number; user?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    const prefix = ["-d", this.distro, ...(options.user ? ["-u", options.user] : []), "--"];
    const result = await execFileAsync("wsl.exe", [...prefix, ...args], {
      encoding: "utf8",
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      input: options.input,
      env: forwardWslRuntimeEnvironment(process.env),
    } as Parameters<typeof execFileAsync>[2]);
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn("wsl.exe", ["-d", this.distro, "--", ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: forwardWslRuntimeEnvironment(process.env),
    });
  }

  async pipe(args: string[], input: string, timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
    const child = this.spawn(args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.stdin.end(input);
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`WSL command timed out: ${args[0]}`)); }, timeout);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) accept({ stdout, stderr });
        else reject(new Error(stderr.trim() || `WSL command exited with code ${code}`));
      });
    });
  }

  async toLinuxPath(value: string): Promise<string> {
    if (!value) return "";
    if (value.startsWith("/")) return value;
    const unc = uncWslPath(value);
    if (unc) return unc.path;
    const drive = value.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`;
    const { stdout } = await this.exec(["wslpath", "-a", "-u", value]);
    return stdout.trim();
  }

  async toRuntimePath(value: string): Promise<string> { return this.toLinuxPath(value); }

  async revealPath(path: string): Promise<string> {
    return path.startsWith("/") ? `\\\\wsl.localhost\\${this.distro}${path.replaceAll("/", "\\")}` : path;
  }

  async homeDirectory(): Promise<string> {
    this.homePromise ??= this.exec(["sh", "-lc", "printf %s \"$HOME\""]).then(({ stdout }) => {
      const value = stdout.trim();
      if (!value.startsWith("/")) throw new Error("Unable to resolve the WSL home directory.");
      return value;
    }).catch((error) => { this.homePromise = undefined; throw error; });
    return this.homePromise;
  }

  async commandPath(name: "node" | "uv"): Promise<string> {
    const { stdout } = await this.exec(["bash", "-lc", `export PATH="$HOME/.local/bin:$PATH"; command -v ${name}`]);
    const value = stdout.trim();
    if (!value.startsWith("/")) throw new Error(`${name} is not available in WSL.`);
    return value;
  }

  async resolveRuntimePaths(settings: AppSettings): Promise<{ piCadRepo: string; primeAgentRepo: string; projectPath: string }> {
    const home = await this.homeDirectory();
    const runtimeRoot = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT
      ? await this.toLinuxPath(process.env.PI_CAD_DESKTOP_RUNTIME_ROOT)
      : `${home}/.local/share/pi-cad-desktop/runtime`;
    const piCadRepo = settings.piCadRepo ? await this.toLinuxPath(settings.piCadRepo) : `${runtimeRoot}/pi-cad`;
    const projectPath = settings.projectPath ? await this.toLinuxPath(settings.projectPath) : "";
    const primeAgentRepo = settings.primeAgentRepo
      ? await this.toLinuxPath(settings.primeAgentRepo)
      : `${runtimeRoot}/prime-agent`;
    return { piCadRepo, primeAgentRepo, projectPath };
  }

  async check(settings: AppSettings): Promise<RuntimeStatus> {
    const checks: DependencyCheck[] = [];
    const add = (id: DependencyCheck["id"], label: string, ready: boolean, detail: string, installable = true) =>
      checks.push({ id, label, status: ready ? "ready" : "missing", detail, installable });
    try {
      const { stdout } = await execFileAsync("wsl.exe", ["-l", "-q"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      const distributions = String(stdout || "").replaceAll("\0", "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const found = distributions.some((item) => item.toLowerCase() === settings.distro.toLowerCase());
      add("wsl", "WSL 2 and Ubuntu", found, found ? settings.distro : `${settings.distro} is not installed`, true);
      if (!found) return { state: "error", checks, message: "Install WSL 2 and Ubuntu to continue." };
    } catch (error) {
      add("wsl", "WSL 2 and Ubuntu", false, String(error), true);
      return { state: "error", checks, message: "Install WSL 2 and Ubuntu to continue." };
    }
    try {
      await execFileAsync("wsl.exe", ["-d", settings.distro, "--", "true"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    } catch {
      return {
        state: "action-required", checks, action: "initialize-ubuntu", progress: 0.28,
        message: "Ubuntu needs its one-time setup. Open Ubuntu from the Start menu, create its user, then check again.",
      };
    }
    const paths = await this.resolveRuntimePaths(settings);
    const usesBundledRuntime = !settings.piCadRepo && !settings.primeAgentRepo && Boolean(this.bundledRuntimePath);
    const bundledSource = usesBundledRuntime ? await this.toLinuxPath(this.bundledRuntimePath!) : "";
    const installedRoot = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT
      ? await this.toLinuxPath(process.env.PI_CAD_DESKTOP_RUNTIME_ROOT)
      : `${await this.homeDirectory()}/.local/share/pi-cad-desktop/runtime`;
    const knowledge = engineeringKnowledgeProbe(paths.piCadRepo);
    const script = [
      "export PATH=\"$HOME/.local/bin:$PATH\"",
      "printf 'node='",
      "node -p 'process.versions.node' 2>/dev/null || true",
      "printf 'uv=%s\\n' \"$(command -v uv || true)\"",
      "printf 'bwrap=%s\\n' \"$(command -v bwrap || true)\"",
      "printf 'paraview=%s\\n' \"$(command -v paraview || true)\"",
      `test -f ${JSON.stringify(paths.primeAgentRepo)}/prime-agent.sh && printf 'prime=ready\\n' || printf 'prime=missing\\n'`,
      `test -f ${JSON.stringify(paths.piCadRepo)}/package.json && printf 'picad=ready\\n' || printf 'picad=missing\\n'`,
      knowledge.command,
      usesBundledRuntime
        ? `cmp -s ${JSON.stringify(bundledSource)}/manifest.json ${JSON.stringify(installedRoot)}/manifest.json && printf 'bundle=ready\\n' || printf 'bundle=missing\\n'`
        : "printf 'bundle=ready\\n'",
      "printf 'python=%s\\n' \"$(command -v python3 || true)\"",
    ].join("; ");
    const { stdout } = await this.exec(["bash", "-lc", script], { timeout: 120_000 });
    const values = Object.fromEntries(stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2))) as Record<string, string>;
    const nodeMajor = Number(values.node?.split(".")[0] || 0);
    add("node", "Node.js 22+", nodeMajor >= 22, values.node || "Not installed");
    add("python", "Python", Boolean(values.python), values.python || "Not installed");
    add("uv", "uv", Boolean(values.uv), values.uv || "Not installed");
    add("bwrap", "Bubblewrap", Boolean(values.bwrap), values.bwrap || "Not installed");
    add("paraview", "ParaView", Boolean(values.paraview), values.paraview || "Not installed");
    const bundleReady = values.bundle === "ready";
    add("prime", "Prime Agent", values.prime === "ready" && bundleReady, bundleReady ? paths.primeAgentRepo : "Bundled runtime update available");
    const knowledgeReady = values.knowledge === String(knowledge.count);
    add("picad", "Pi-CAD runtime", values.picad === "ready" && knowledgeReady && bundleReady,
      !bundleReady ? "Bundled runtime update available" : !knowledgeReady ? "Required engineering skills are missing" : `${paths.piCadRepo} · ${knowledge.count} engineering skills`);
    const ready = checks.every((check) => check.status === "ready");
    return { state: ready ? "idle" : "error", checks, message: ready ? undefined : "Install the missing runtime dependencies." };
  }

  async installWsl(onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> {
    if (!/^[A-Za-z0-9._-]+$/.test(this.distro)) throw new Error("Invalid WSL distribution name.");
    const command = wslInstallPowerShellCommand(this.distro);
    const startedAt = Date.now();
    onStatus?.(wslInstallHeartbeat(0));
    const heartbeat = setInterval(() => onStatus?.(wslInstallHeartbeat(Date.now() - startedAt)), 2_000);
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
        encoding: "utf8", timeout: 30 * 60_000, windowsHide: true,
      });
      let distroPresent = false;
      try {
        const { stdout } = await execFileAsync("wsl.exe", ["-l", "-q"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
        distroPresent = String(stdout || "").replaceAll("\0", "").split(/\r?\n/).some((item) => item.trim().toLowerCase() === this.distro.toLowerCase());
      } catch {}
      // --no-launch deliberately leaves the interactive Unix-user setup to a
      // visible Ubuntu window instead of trapping it in our hidden installer.
      const status = classifyWslInstallResult({ exitCode: 0, distroPresent, distroReady: false });
      onStatus?.(status);
      return status;
    } catch (error: any) {
      if (error?.code === 1223) throw new Error("Administrator approval was cancelled.");
      throw new Error(`Windows could not install WSL. ${error?.stderr || error?.message || error}`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async install(settings: AppSettings, onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> {
    let status = await this.check(settings);
    const report = (message: string, progress: number) => onStatus?.({ ...status, state: "installing", message, progress });
    report("Checking runtime components…", 0.05);
    if (status.checks.some((item) => item.id === "wsl" && item.status !== "ready")) return status;
    const missing = new Set(status.checks.filter((item) => item.status !== "ready").map((item) => item.id));
    if (missing.has("python") || missing.has("bwrap") || missing.has("paraview")) {
      report("Installing Python, sandbox, and 3D viewing packages…", 0.15);
      await execFileAsync("wsl.exe", ["-d", this.distro, "-u", "root", "--", "bash", "-lc", "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv bubblewrap curl ca-certificates paraview python3-paraview"], {
        encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
    }
    if (missing.has("uv")) {
      report("Installing the Python package runner…", 0.4);
      await this.exec(["bash", "-lc", "curl -LsSf https://astral.sh/uv/install.sh | sh"], { timeout: 5 * 60_000 });
    }
    if (missing.has("node")) {
      report("Installing Node.js…", 0.5);
      const script = [
        "set -e",
        "picad_node_version=v22.23.2",
        "case $(uname -m) in x86_64) picad_node_arch=x64 ;; aarch64|arm64) picad_node_arch=arm64 ;; *) echo 'Unsupported CPU architecture' >&2; exit 1 ;; esac",
        "picad_node_root=$HOME/.local/lib/nodejs",
        "picad_node_dir=$picad_node_root/node-$picad_node_version-linux-$picad_node_arch",
        "mkdir -p $picad_node_root $HOME/.local/bin",
        "curl -fsSLo /tmp/pi-cad-node.tar.gz https://nodejs.org/dist/$picad_node_version/node-$picad_node_version-linux-$picad_node_arch.tar.gz",
        "tar -xzf /tmp/pi-cad-node.tar.gz -C $picad_node_root",
        "ln -sfn $picad_node_dir/bin/node $HOME/.local/bin/node",
        "ln -sfn $picad_node_dir/bin/npm $HOME/.local/bin/npm",
        "ln -sfn $picad_node_dir/bin/npx $HOME/.local/bin/npx",
      ].join("; ");
      await this.exec(["bash", "-lc", script], { timeout: 10 * 60_000 });
    }
    let paths = await this.resolveRuntimePaths(settings);
    if ((missing.has("prime") || missing.has("picad")) && this.bundledRuntimePath) {
      report("Copying the bundled engineering runtime…", 0.62);
      const source = await this.toLinuxPath(this.bundledRuntimePath);
      const home = await this.homeDirectory();
      const destination = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT
        ? await this.toLinuxPath(process.env.PI_CAD_DESKTOP_RUNTIME_ROOT)
        : `${home}/.local/share/pi-cad-desktop/runtime`;
      const archive = `${source}/runtime-bundle.tar.gz`;
      const installBundled = [
        "set -e",
        `mkdir -p ${JSON.stringify(destination)}`,
        `if test -f ${JSON.stringify(archive)}; then tar -xzf ${JSON.stringify(archive)} -C ${JSON.stringify(destination)}; else cp -a ${JSON.stringify(source)}/. ${JSON.stringify(destination)}/; fi`,
        `cp ${JSON.stringify(source)}/manifest.json ${JSON.stringify(destination)}/manifest.json`,
        `chmod +x ${JSON.stringify(destination)}/prime-agent/prime-agent.sh`,
      ].join("; ");
      await this.exec(["bash", "-lc", installBundled], { timeout: 15 * 60_000 });
      paths = await this.resolveRuntimePaths(settings);
    }
    try {
      await Promise.all([
        this.exec(["test", "-f", `${paths.primeAgentRepo}/prime-agent.sh`]),
        this.exec(["test", "-f", `${paths.piCadRepo}/package.json`]),
      ]);
    } catch {
      throw new Error(`Bundled engineering runtime is not staged at ${paths.piCadRepo}. Reinstall Pi-CAD or select development checkouts in Settings.`);
    }
    report("Preparing Pi-CAD Python packages…", 0.78);
    await this.exec(["bash", "-lc", `export PATH="$HOME/.local/bin:$PATH"; cd ${JSON.stringify(paths.piCadRepo)} && if ! test -d node_modules/jiti -a -d node_modules/typebox -a -d node_modules/yaml; then npm install --omit=dev --legacy-peer-deps; fi && npm run setup:python`], { timeout: 15 * 60_000 });
    report("Connecting Prime Agent to Pi-CAD…", 0.92);
    await this.exec(["bash", "-lc", [
      "set -e",
      `mkdir -p ${JSON.stringify(paths.piCadRepo)}/node_modules/@earendil-works`,
      `ln -sfn ${JSON.stringify(paths.primeAgentRepo)}/packages/coding-agent ${JSON.stringify(paths.piCadRepo)}/node_modules/@earendil-works/pi-coding-agent`,
      `ln -sfn ${JSON.stringify(paths.primeAgentRepo)}/packages/ai ${JSON.stringify(paths.piCadRepo)}/node_modules/@earendil-works/pi-ai`,
    ].join("; ")]);
    report("Verifying the installation…", 0.97);
    status = await this.check(settings);
    onStatus?.(status);
    return status;
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}
