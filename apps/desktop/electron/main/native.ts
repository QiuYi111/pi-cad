import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { AppSettings, DependencyCheck, RuntimeStatus } from "../../src/shared/contracts.js";
import { engineeringKnowledgeProbe, type RuntimeBridge, type RuntimePaths } from "./runtime-bridge.js";

const execFileAsync = promisify(execFile);

export class NativeBridge implements RuntimeBridge {
  readonly kind = "native" as const;
  constructor(readonly bundledRuntimePath?: string, private readonly electronExecutable = process.execPath) {}

  async exec(args: string[], options: { input?: string; timeout?: number; user?: string } = {}) {
    if (options.user) throw new Error("Native runtime cannot change users.");
    const [command, ...rest] = args;
    if (!command) throw new Error("Runtime command is empty.");
    const result = await execFileAsync(command, rest, {
      encoding: "utf8", timeout: options.timeout ?? 30_000, maxBuffer: 16 * 1024 * 1024,
      input: options.input, env: this.environment(command),
    } as Parameters<typeof execFileAsync>[2]);
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    const [command, ...rest] = args;
    if (!command) throw new Error("Runtime command is empty.");
    return spawn(command, rest, { stdio: ["pipe", "pipe", "pipe"], env: this.environment(command) });
  }

  async pipe(args: string[], input: string, timeout = 30_000) { return this.exec(args, { input, timeout }); }
  async toRuntimePath(value: string) { return isAbsolute(value) ? resolve(value) : resolve(value); }
  async homeDirectory() { return homedir(); }
  async revealPath(path: string) { return path; }

  private environment(command: string): NodeJS.ProcessEnv {
    return command === this.electronExecutable ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
  }

  async commandPath(name: "node" | "uv"): Promise<string> {
    if (name === "node") {
      const directory = `${homedir()}/.local/share/pi-cad-desktop/bin`;
      const wrapper = `${directory}/node`;
      await mkdir(directory, { recursive: true });
      await writeFile(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(this.electronExecutable)} "$@"\n`, { encoding: "utf8", mode: 0o755 });
      await chmod(wrapper, 0o755);
      return wrapper;
    }
    const { stdout } = await this.exec(["bash", "-lc", `export PATH="$HOME/.local/bin:$PATH"; command -v ${name}`]);
    const value = stdout.trim();
    if (!value.startsWith("/")) throw new Error(`${name} is not available.`);
    return value;
  }

  async resolveRuntimePaths(settings: AppSettings): Promise<RuntimePaths> {
    const home = homedir();
    const runtimeRoot = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT
      ? resolve(process.env.PI_CAD_DESKTOP_RUNTIME_ROOT)
      : `${home}/.local/share/pi-cad-desktop/runtime`;
    return {
      piCadRepo: settings.piCadRepo ? await this.toRuntimePath(settings.piCadRepo) : `${runtimeRoot}/pi-cad`,
      primeAgentRepo: settings.primeAgentRepo ? await this.toRuntimePath(settings.primeAgentRepo) : `${runtimeRoot}/prime-agent`,
      projectPath: settings.projectPath ? await this.toRuntimePath(settings.projectPath) : "",
    };
  }

  async check(settings: AppSettings): Promise<RuntimeStatus> {
    const checks: DependencyCheck[] = [];
    const add = (id: DependencyCheck["id"], label: string, ready: boolean, detail: string, installable = true) => checks.push({ id, label, status: ready ? "ready" : "missing", detail, installable });
    add("host", process.platform === "darwin" ? "macOS runtime" : "Linux runtime", true, `${process.platform}-${process.arch}`, false);
    const paths = await this.resolveRuntimePaths(settings);
    const usesBundledRuntime = !settings.piCadRepo && !settings.primeAgentRepo && Boolean(this.bundledRuntimePath);
    const installedRoot = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT
      ? resolve(process.env.PI_CAD_DESKTOP_RUNTIME_ROOT)
      : `${homedir()}/.local/share/pi-cad-desktop/runtime`;
    const knowledge = engineeringKnowledgeProbe(paths.piCadRepo);
    const sandbox = process.platform === "darwin" ? "sandbox-exec" : "bwrap";
    const script = [
      "export PATH=\"$HOME/.local/bin:$PATH\"",
      "printf 'uv=%s\\n' \"$(command -v uv || true)\"",
      `printf 'sandbox=%s\\n' \"$(command -v ${sandbox} || true)\"`,
      "printf 'paraview=%s\\n' \"$(command -v paraview || true)\"",
      `test -f ${JSON.stringify(paths.primeAgentRepo)}/prime-agent.sh && printf 'prime=ready\\n' || printf 'prime=missing\\n'`,
      `test -f ${JSON.stringify(paths.piCadRepo)}/package.json && printf 'picad=ready\\n' || printf 'picad=missing\\n'`,
      knowledge.command,
      usesBundledRuntime
        ? `cmp -s ${JSON.stringify(this.bundledRuntimePath!)}/manifest.json ${JSON.stringify(installedRoot)}/manifest.json && printf 'bundle=ready\\n' || printf 'bundle=missing\\n'`
        : "printf 'bundle=ready\\n'",
    ].join("; ");
    const { stdout } = await this.exec(["bash", "-lc", script], { timeout: 30_000 });
    const values = Object.fromEntries(stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2))) as Record<string, string>;
    add("node", "Bundled Node.js", true, process.versions.node, false);
    add("uv", "uv and managed Python", Boolean(values.uv), values.uv || "Not installed");
    add("sandbox", process.platform === "darwin" ? "macOS Sandbox" : "Bubblewrap", Boolean(values.sandbox), values.sandbox || "Not installed", process.platform !== "darwin");
    add("paraview", "ParaView", Boolean(values.paraview), values.paraview || "Install ParaView 6", false);
    const bundleReady = values.bundle === "ready";
    add("prime", "Prime Agent", values.prime === "ready" && bundleReady, bundleReady ? paths.primeAgentRepo : "Bundled runtime update available");
    const knowledgeReady = values.knowledge === String(knowledge.count);
    add("picad", "Pi-CAD runtime", values.picad === "ready" && knowledgeReady && bundleReady,
      !bundleReady ? "Bundled runtime update available" : !knowledgeReady ? "Required engineering skills are missing" : `${paths.piCadRepo} · ${knowledge.count} engineering skills`);
    const ready = checks.every((check) => check.status === "ready");
    return { state: ready ? "idle" : "error", checks, message: ready ? undefined : "Install the missing runtime dependencies." };
  }

  async installWsl(_onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> { throw new Error("WSL installation is available only on Windows."); }

  async install(settings: AppSettings, onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> {
    let status = await this.check(settings);
    onStatus?.({ ...status, state: "installing", message: "Preparing the native engineering runtime…" });
    const missing = new Set(status.checks.filter((item) => item.status !== "ready").map((item) => item.id));
    if (missing.has("sandbox")) {
      if (process.platform === "darwin") throw new Error("sandbox-exec is unavailable on this macOS installation.");
      throw new Error("Install Bubblewrap with your Linux package manager, then retry.");
    }
    if (missing.has("paraview")) throw new Error("Install ParaView 6, then retry. Native ParaView bundling is not present in this package.");
    if (missing.has("uv")) {
      await this.exec(["bash", "-lc", "curl -LsSf https://astral.sh/uv/install.sh | sh"], { timeout: 5 * 60_000 });
    }
    const paths = await this.resolveRuntimePaths(settings);
    if ((missing.has("prime") || missing.has("picad")) && this.bundledRuntimePath) {
      const destination = process.env.PI_CAD_DESKTOP_RUNTIME_ROOT
        ? resolve(process.env.PI_CAD_DESKTOP_RUNTIME_ROOT)
        : `${homedir()}/.local/share/pi-cad-desktop/runtime`;
      await mkdir(destination, { recursive: true });
      await this.exec(["tar", "-xzf", `${this.bundledRuntimePath}/runtime-bundle.tar.gz`, "-C", destination], { timeout: 15 * 60_000 });
      await this.exec(["cp", `${this.bundledRuntimePath}/manifest.json`, `${destination}/manifest.json`]);
      await chmod(`${destination}/prime-agent/prime-agent.sh`, 0o755);
    }
    const updated = await this.resolveRuntimePaths(settings);
    const node = await this.commandPath("node");
    await this.exec(["bash", "-lc", `export PATH="$HOME/.local/bin:$PATH"; export PI_CAD_UV="$(command -v uv)"; cd ${JSON.stringify(updated.piCadRepo)} && ${JSON.stringify(node)} scripts/postinstall.mjs`], { timeout: 20 * 60_000 });
    await mkdir(`${updated.piCadRepo}/node_modules/@earendil-works`, { recursive: true });
    for (const [name, directory] of [["pi-coding-agent", "coding-agent"], ["pi-ai", "ai"]] as const) {
      await this.exec(["ln", "-sfn", `${updated.primeAgentRepo}/packages/${directory}`, `${updated.piCadRepo}/node_modules/@earendil-works/${name}`]);
    }
    status = await this.check(settings);
    onStatus?.(status);
    return status;
  }
}
