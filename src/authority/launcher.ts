import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { assertLinuxRuntime } from "../shared/platform.ts";
import { completionGate, startAuthoritySidecar } from "./sidecar.ts";
import { canonicalProjectKey, defaultCanonicalProjectDirectory } from "./storage.ts";

export const WORKFLOW_INCOMPLETE_EXIT_CODE = 42;

export interface LaunchPaths {
  repository: string;
  project: string;
  primeRoot: string;
  nodeRoot: string;
  primeAgentDir: string;
  primeKernelVenv: string;
  kernelPythonRoot: string;
  kernelPythonExecutable: string;
  kernelSitePackages: string;
  runtimeDirectory: string;
  ephemeralAgentDir: string;
  authorSocketDirectory: string;
}

export function buildReviewerBwrapArgs(paths: LaunchPaths, input: { reviewId: string; reviewerAgentDir: string; reviewerWorkspace: string; reviewerSocketDirectory: string; prompt: string; modelArgs?: string[] }): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime", "--dir", "/opt", "--dir", "/run", "--dir", "/run/pi-cad"];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) systemBind(args, path);
  args.push(
    "--bind", input.reviewerWorkspace, "/workspace",
    "--ro-bind", paths.primeRoot, "/opt/prime", "--ro-bind", paths.nodeRoot, "/opt/node",
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad-skill",
    "--ro-bind", join(paths.repository, "node_modules"), "/opt/pi-cad/node_modules",
    "--ro-bind", paths.primeKernelVenv, "/opt/prime-kernel-venv", "--ro-bind", paths.kernelPythonRoot, "/opt/python",
    "--bind", input.reviewerAgentDir, "/home/prime/.prime/agent",
    "--ro-bind", input.reviewerSocketDirectory, "/run/pi-cad/reviewer",
    "--chdir", "/workspace",
    "--setenv", "HOME", "/home/prime", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/opt/node/bin:/opt/prime:/opt/prime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "PI_CAD_REVIEWER_SOCKET", "/run/pi-cad/reviewer/authority.sock",
    "--setenv", "PI_CAD_REVIEW_ID", input.reviewId,
    "--setenv", "PI_CAD_REVIEWER_MODE", "1", "--setenv", "PI_CAD_PROJECT_CWD", "/workspace",
    "--setenv", "PI_CAD_REPO", "/opt/pi-cad", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    "--setenv", "PYTHONPATH", `/opt/prime-kernel-venv/${paths.kernelSitePackages}:/opt/pi-cad/cad-skill/src`,
    "--setenv", "PRIME_AGENT_REPO", "/opt/prime", "--setenv", "PRIME_AGENT_CODING_AGENT_DIR", "/home/prime/.prime/agent",
    "--setenv", "PRIME_AGENT_KERNEL_PYTHON", `/opt/python/bin/${paths.kernelPythonExecutable}`,
    "--setenv", "PI_OFFLINE", "1",
  );
  for (const name of ["TERM", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"]) passEnvironment(args, name, process.env[name]);
  args.push("--", "/opt/prime/prime-agent.sh", "--cwd", "/workspace", "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "ipython", "--skill", "/opt/pi-cad/cad-skill/SKILL.md", ...(input.modelArgs ?? []), "--autonomous", "--autonomous-max-turns", "16", "--autonomous-timeout-ms", "115000", "--no-session", "--mode", "json", "--print", input.prompt);
  return args;
}

function systemBind(args: string[], path: string): void {
  if (existsSync(path)) args.push("--ro-bind", path, path);
}

function passEnvironment(args: string[], name: string, value: string | undefined): void {
  if (value !== undefined) args.push("--setenv", name, value);
}

export function buildPrimeBwrapArgs(paths: LaunchPaths, primeArgs: string[]): string[] {
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime",
    "--dir", "/opt", "--dir", "/run", "--dir", "/run/pi-cad",
  ];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) systemBind(args, path);
  args.push(
    "--bind", paths.project, "/workspace",
    "--ro-bind", paths.primeRoot, "/opt/prime",
    "--ro-bind", paths.nodeRoot, "/opt/node",
    "--ro-bind", join(paths.repository, "src", "integrations", "prime"), "/opt/pi-cad/prime-extension",
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad-skill",
    "--ro-bind", join(paths.repository, "packages", "prime-codex-image-gen"), "/opt/pi-cad/imagegen",
    "--ro-bind", join(paths.repository, "node_modules"), "/opt/pi-cad/node_modules",
    "--ro-bind", paths.primeKernelVenv, "/opt/prime-kernel-venv",
    "--ro-bind", paths.kernelPythonRoot, "/opt/python",
    "--bind", paths.ephemeralAgentDir, "/home/prime/.prime/agent",
    "--ro-bind", paths.authorSocketDirectory, "/run/pi-cad/author",
    "--chdir", "/workspace",
    "--setenv", "HOME", "/home/prime",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/opt/node/bin:/opt/prime:/opt/prime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "PI_CAD_AUTHOR_SOCKET", "/run/pi-cad/author/authority.sock",
    "--setenv", "PI_CAD_PROJECT_CWD", "/workspace",
    "--setenv", "PI_CAD_REPO", "/opt/pi-cad",
    "--setenv", "PYTHONPATH", `/opt/prime-kernel-venv/${paths.kernelSitePackages}:/opt/pi-cad/cad-skill/src`,
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    "--setenv", "PRIME_AGENT_REPO", "/opt/prime",
    "--setenv", "PRIME_AGENT_CODING_AGENT_DIR", "/home/prime/.prime/agent",
    "--setenv", "PRIME_AGENT_SESSION_DIR", "/workspace/.prime-sessions",
    "--setenv", "PRIME_AGENT_KERNEL_PYTHON", `/opt/python/bin/${paths.kernelPythonExecutable}`,
    "--setenv", "PI_OFFLINE", process.env.PI_OFFLINE ?? "1",
  );
  for (const name of ["TERM", "COLORTERM", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"]) {
    passEnvironment(args, name, process.env[name]);
  }
  args.push(
    "--", "/opt/prime/prime-agent.sh",
    "--cwd", "/workspace",
    "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython,codex_generate_image",
    "--extension", "/opt/pi-cad/prime-extension/extension.ts",
    "--extension", "/opt/pi-cad/imagegen/index.ts",
    "--skill", "/opt/pi-cad/cad-skill/SKILL.md",
    "--skill", "/opt/pi-cad/imagegen/skills/imagegen/SKILL.md",
    ...primeArgs,
  );
  return args;
}

function isOneShot(args: string[]): boolean {
  if (args.includes("--print") || args.includes("-p")) return true;
  const mode = args.findIndex((value) => value === "--mode");
  return mode >= 0 && ["text", "json"].includes(args[mode + 1] ?? "");
}

async function copyPrimeBootstrap(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "settings.json", "telemetry.json"]) {
    try { await copyFile(join(source, name), join(destination, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function disableReviewerCompaction(agentDirectory: string): Promise<void> {
  const path = join(agentDirectory, "settings.json");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  settings.compaction = { ...((settings.compaction && typeof settings.compaction === "object") ? settings.compaction as Record<string, unknown> : {}), enabled: false, agentCallable: false };
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function childExit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => accept({ code: code ?? 1, signal }));
  });
}

function boundedChildExit(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; signal: NodeJS.Signals | null; diagnostic: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let diagnostic = "";
    const append = (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-8192); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); accept({ code: timedOut ? 124 : (code ?? 1), signal, diagnostic }); });
  });
}

function reviewerModelArgs(primeArgs: string[]): string[] {
  const selected: string[] = [];
  for (const name of ["--provider", "--model", "--thinking"]) {
    const index = primeArgs.indexOf(name);
    if (index >= 0 && primeArgs[index + 1] && !primeArgs[index + 1]!.startsWith("-")) selected.push(name, primeArgs[index + 1]!);
  }
  return selected;
}

export async function main(primeArgs = process.argv.slice(2)): Promise<number> {
  assertLinuxRuntime("Pi-CAD authority sidecar");
  if (primeArgs.some((value) => value === "--cwd" || value.startsWith("--cwd="))) {
    throw new Error("prime-cad owns --cwd so the sandbox cannot escape its project root");
  }
  const repository = realpathSync(resolve(process.env.PI_CAD_REPO ?? resolve(import.meta.dirname, "..", "..")));
  const project = await realpath(resolve(process.env.PI_CAD_PROJECT_CWD ?? process.cwd()));
  const primeRoot = realpathSync(resolve(process.env.PRIME_AGENT_REPO ?? resolve(repository, "../prime-agent-plan-c-upstream")));
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const primeAgentDir = resolve(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime-plan-c", "agent"));
  const primeKernelVenv = resolve(process.env.PRIME_AGENT_KERNEL_VENV ?? join(homedir(), ".prime-plan-c", "kernel-venv"));
  const kernelPython = realpathSync(join(primeKernelVenv, "bin", "python"));
  const kernelPythonRoot = dirname(dirname(kernelPython));
  const kernelPythonExecutable = basename(kernelPython);
  const kernelPythonLibrary = readdirSync(join(primeKernelVenv, "lib"), { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith("python") && existsSync(join(primeKernelVenv, "lib", entry.name, "site-packages")));
  if (!kernelPythonLibrary) throw new Error(`Prime kernel venv has no site-packages: ${primeKernelVenv}`);
  const kernelSitePackages = join("lib", kernelPythonLibrary.name, "site-packages");
  const runtimeBase = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR)
    ? resolve(process.env.XDG_RUNTIME_DIR, "pi-cad")
    : resolve(tmpdir(), `pi-cad-${userInfo().uid}`);
  const runtimeDirectory = join(runtimeBase, `${canonicalProjectKey(project).slice(0, 20)}-${process.pid}`);
  const ephemeralAgentDir = join(runtimeDirectory, "prime-agent");
  const reviewerAgentDir = join(runtimeDirectory, "reviewer-agent");
  const reviewerWorkspace = join(runtimeDirectory, "reviewer-workspace");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await copyPrimeBootstrap(primeAgentDir, ephemeralAgentDir);
  await copyPrimeBootstrap(primeAgentDir, reviewerAgentDir);
  await disableReviewerCompaction(reviewerAgentDir);
  await mkdir(reviewerWorkspace, { recursive: true, mode: 0o700 });
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = defaultCanonicalProjectDirectory(project);
  await mkdir(process.env.PI_CAD_CANONICAL_PROJECT_DIR, { recursive: true, mode: 0o700 });
  let reviewerSocketDirectory = "";
  let launchPaths!: LaunchPaths;
  const sidecar = await startAuthoritySidecar({
    cwd: project, runtimeDirectory,
    reviewerExecutor: async ({ reviewId, prompt }) => {
      // OAuth providers may rotate the refresh token while the author is
      // running. Snapshot the live isolated author bootstrap at admission so
      // a late reviewer never starts with the stale launch-time copy.
      await copyPrimeBootstrap(ephemeralAgentDir, reviewerAgentDir);
      await disableReviewerCompaction(reviewerAgentDir);
      const result = await boundedChildExit("/usr/bin/bwrap", buildReviewerBwrapArgs(launchPaths, { reviewId, reviewerAgentDir, reviewerWorkspace, reviewerSocketDirectory, prompt, modelArgs: reviewerModelArgs(primeArgs) }), { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, 120_000);
      if (result.code !== 0) {
        const detail = result.diagnostic.trim().split("\n").slice(-3).join(" | ").replace(/[A-Za-z0-9_-]{80,}/g, "[redacted]");
        throw new Error(`${result.code === 124 ? "reviewer wall timeout (120s)" : `reviewer exited with code ${result.code}`}${detail ? `: ${detail}` : ""}`);
      }
    },
  });
  const paths: LaunchPaths = {
    repository, project, primeRoot, nodeRoot, primeAgentDir, primeKernelVenv, runtimeDirectory,
    kernelPythonRoot, kernelPythonExecutable, kernelSitePackages,
    ephemeralAgentDir, authorSocketDirectory: resolve(sidecar.authorSocket, ".."),
  };
  launchPaths = paths;
  reviewerSocketDirectory = resolve(sidecar.reviewerSocket, "..");
  try {
    const result = await childExit("/usr/bin/bwrap", buildPrimeBwrapArgs(paths, primeArgs), {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    });
    if (result.signal) {
      return 128;
    }
    if (result.code !== 0 || !isOneShot(primeArgs)) return result.code;
    const gate = await completionGate(project);
    if (!gate.complete) {
      process.stderr.write(`WORKFLOW_INCOMPLETE: ${gate.reason}\n`);
      return WORKFLOW_INCOMPLETE_EXIT_CODE;
    }
    return 0;
  } finally {
    await sidecar.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}
