import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { AppSettings, DependencyCheck, RuntimeStatus } from "../../src/shared/contracts.js";

const execFileAsync = promisify(execFile);

function uncWslPath(value: string): { distro: string; path: string } | null {
  const match = value.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.*)$/i);
  if (!match) return null;
  return { distro: match[1]!, path: `/${match[2]!.replaceAll("\\", "/")}` };
}

export class WslBridge {
  constructor(readonly distro: string, readonly bundledRuntimePath?: string) {}

  async exec(args: string[], options: { input?: string; timeout?: number; user?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    const prefix = ["-d", this.distro, ...(options.user ? ["-u", options.user] : []), "--"];
    const result = await execFileAsync("wsl.exe", [...prefix, ...args], {
      encoding: "utf8",
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      input: options.input,
    } as Parameters<typeof execFileAsync>[2]);
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn("wsl.exe", ["-d", this.distro, "--", ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
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
    const { stdout } = await this.exec(["wslpath", "-a", "-u", value]);
    return stdout.trim();
  }

  async homeDirectory(): Promise<string> {
    const { stdout } = await this.exec(["sh", "-lc", "printf %s \"$HOME\""]);
    const value = stdout.trim();
    if (!value.startsWith("/")) throw new Error("Unable to resolve the WSL home directory.");
    return value;
  }

  async commandPath(name: "node" | "uv"): Promise<string> {
    const { stdout } = await this.exec(["bash", "-lc", `command -v ${name}`]);
    const value = stdout.trim();
    if (!value.startsWith("/")) throw new Error(`${name} is not available in WSL.`);
    return value;
  }

  async resolveRuntimePaths(settings: AppSettings): Promise<{ piCadRepo: string; primeAgentRepo: string; projectPath: string }> {
    const home = await this.homeDirectory();
    const piCadRepo = settings.piCadRepo ? await this.toLinuxPath(settings.piCadRepo) : `${home}/.local/share/pi-cad-desktop/runtime/pi-cad`;
    const projectPath = settings.projectPath ? await this.toLinuxPath(settings.projectPath) : "";
    let primeAgentRepo = settings.primeAgentRepo ? await this.toLinuxPath(settings.primeAgentRepo) : "";
    if (!primeAgentRepo) {
      try {
        const { stdout } = await this.exec(["bash", "-lc", "node -e 'const fs=require(\"fs\"),os=require(\"os\"),p=os.homedir()+\"/.prime/agent/prime-cad.json\";try{process.stdout.write(JSON.parse(fs.readFileSync(p,\"utf8\")).primeAgentRepo||\"\")}catch{}'"]);
        primeAgentRepo = stdout.trim();
      } catch {}
    }
    if (!primeAgentRepo) primeAgentRepo = `${home}/.local/share/pi-cad-desktop/runtime/prime-agent`;
    return { piCadRepo, primeAgentRepo, projectPath };
  }

  async check(settings: AppSettings): Promise<RuntimeStatus> {
    const checks: DependencyCheck[] = [];
    const add = (id: DependencyCheck["id"], label: string, ready: boolean, detail: string, installable = true) =>
      checks.push({ id, label, status: ready ? "ready" : "missing", detail, installable });
    try {
      await execFileAsync("wsl.exe", ["-l", "-q"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      add("wsl", "Windows Subsystem for Linux", true, settings.distro, false);
    } catch (error) {
      add("wsl", "Windows Subsystem for Linux", false, String(error), false);
      return { state: "error", checks, message: "WSL is required before Pi-CAD can install its engineering runtime." };
    }
    const paths = await this.resolveRuntimePaths(settings);
    const script = [
      "node=$(command -v node || true)",
      "nodev=$([ -n \"$node\" ] && node -p 'process.versions.node' 2>/dev/null || true)",
      "printf 'node=%s\\n' \"$nodev\"",
      "printf 'uv=%s\\n' \"$(command -v uv || true)\"",
      "printf 'bwrap=%s\\n' \"$(command -v bwrap || true)\"",
      `test -f ${JSON.stringify(paths.primeAgentRepo)}/prime-agent.sh && printf 'prime=ready\\n' || printf 'prime=missing\\n'`,
      `test -f ${JSON.stringify(paths.piCadRepo)}/package.json && printf 'picad=ready\\n' || printf 'picad=missing\\n'`,
      "printf 'python=%s\\n' \"$(command -v python3 || true)\"",
    ].join("; ");
    const { stdout } = await this.exec(["bash", "-lc", script]);
    const values = Object.fromEntries(stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2))) as Record<string, string>;
    const nodeMajor = Number(values.node?.split(".")[0] || 0);
    add("node", "Node.js 22+", nodeMajor >= 22, values.node || "Not installed");
    add("python", "Python", Boolean(values.python), values.python || "Not installed");
    add("uv", "uv", Boolean(values.uv), values.uv || "Not installed");
    add("bwrap", "Bubblewrap", Boolean(values.bwrap), values.bwrap || "Not installed");
    add("prime", "Prime Agent", values.prime === "ready", paths.primeAgentRepo);
    add("picad", "Pi-CAD runtime", values.picad === "ready", paths.piCadRepo);
    const ready = checks.every((check) => check.status === "ready");
    return { state: ready ? "idle" : "error", checks, message: ready ? undefined : "Install the missing runtime dependencies." };
  }

  async install(settings: AppSettings, onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> {
    let status = await this.check(settings);
    onStatus?.({ ...status, state: "installing" });
    if (status.checks.some((item) => item.id === "wsl" && item.status !== "ready")) return status;
    const missing = new Set(status.checks.filter((item) => item.status !== "ready").map((item) => item.id));
    if (missing.has("python") || missing.has("bwrap")) {
      await execFileAsync("wsl.exe", ["-d", this.distro, "-u", "root", "--", "bash", "-lc", "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv bubblewrap curl ca-certificates"], {
        encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
    }
    if (missing.has("uv")) {
      await this.exec(["bash", "-lc", "curl -LsSf https://astral.sh/uv/install.sh | sh"], { timeout: 5 * 60_000 });
    }
    if (missing.has("node")) {
      await this.exec(["bash", "-lc", "curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell && ~/.local/share/fnm/fnm install 22 && ~/.local/share/fnm/fnm default 22"], { timeout: 10 * 60_000 });
    }
    let paths = await this.resolveRuntimePaths(settings);
    if ((missing.has("prime") || missing.has("picad")) && this.bundledRuntimePath) {
      const source = await this.toLinuxPath(this.bundledRuntimePath);
      const home = await this.homeDirectory();
      const destination = `${home}/.local/share/pi-cad-desktop/runtime`;
      await this.exec(["bash", "-lc", `set -e; mkdir -p ${JSON.stringify(destination)}; cp -a ${JSON.stringify(source)}/. ${JSON.stringify(destination)}/; chmod +x ${JSON.stringify(destination)}/prime-agent/prime-agent.sh`], { timeout: 15 * 60_000 });
      paths = await this.resolveRuntimePaths(settings);
    }
    if (missing.has("prime")) {
      throw new Error(`Bundled Prime runtime is not staged at ${paths.primeAgentRepo}. Reinstall Pi-CAD or select a Prime Agent checkout in Settings.`);
    }
    await this.exec(["bash", "-lc", `cd ${JSON.stringify(paths.piCadRepo)} && npm install --omit=dev --legacy-peer-deps && npm run setup:python`], { timeout: 15 * 60_000 });
    status = await this.check(settings);
    onStatus?.(status);
    return status;
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}
