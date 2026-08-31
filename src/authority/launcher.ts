import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { assertLinuxRuntime } from "../shared/platform.ts";
import { completionGate, startAuthoritySidecar } from "./sidecar.ts";
import { canonicalProjectKey, defaultCanonicalProjectDirectory } from "./storage.ts";
import { experienceRoot, finalizeExperience } from "../experience/store.ts";

export const WORKFLOW_INCOMPLETE_EXIT_CODE = 42;
export const PRIME_CAD_CONFIG_FILE = "prime-cad.json";

export type ReviewerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ReviewerModelSelection { provider: string; model: string; thinking: ReviewerThinkingLevel }
export type ReviewerModelPolicy =
  | { mode: "inherit"; thinking?: ReviewerThinkingLevel }
  | { mode: "fixed"; provider: string; model: string; thinking: ReviewerThinkingLevel };

interface PrimeCadConfig {
  primeAgentRepo?: string;
  reviewer?: "inherit" | {
    inheritAuthor?: boolean;
    provider?: string;
    model?: string;
    thinking?: ReviewerThinkingLevel;
  };
}

const REVIEWER_THINKING_LEVELS = new Set<ReviewerThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function readPrimeCadConfig(primeAgentDir: string): PrimeCadConfig {
  const configPath = join(primeAgentDir, PRIME_CAD_CONFIG_FILE);
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("configuration must be a JSON object");
    return parsed as PrimeCadConfig;
  } catch (error) {
    throw new Error(`Invalid Prime configuration at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function reviewerThinking(value: unknown, source: string): ReviewerThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REVIEWER_THINKING_LEVELS.has(value as ReviewerThinkingLevel)) {
    throw new Error(`${source} must be one of ${[...REVIEWER_THINKING_LEVELS].join(", ")}`);
  }
  return value as ReviewerThinkingLevel;
}

function reviewerPolicyFromConfig(config: PrimeCadConfig, configPath: string): ReviewerModelPolicy {
  const reviewer = config.reviewer;
  if (reviewer === undefined || reviewer === "inherit") return { mode: "inherit" };
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) throw new Error(`${configPath}.reviewer must be "inherit" or an object`);
  const thinking = reviewerThinking(reviewer.thinking, `${configPath}.reviewer.thinking`);
  if (reviewer.inheritAuthor === true) {
    if (reviewer.provider !== undefined || reviewer.model !== undefined) throw new Error(`${configPath}.reviewer cannot combine inheritAuthor with provider/model`);
    return { mode: "inherit", ...(thinking ? { thinking } : {}) };
  }
  if (typeof reviewer.provider !== "string" || !reviewer.provider.trim() || typeof reviewer.model !== "string" || !reviewer.model.trim()) {
    throw new Error(`${configPath}.reviewer fixed configuration requires non-empty provider and model`);
  }
  return { mode: "fixed", provider: reviewer.provider.trim(), model: reviewer.model.trim(), thinking: thinking ?? "medium" };
}

function optionValue(args: string[], index: number, name: string): { value: string; consumed: number } | null {
  const value = args[index]!;
  if (value.startsWith(`${name}=`)) return { value: value.slice(name.length + 1), consumed: 1 };
  if (value !== name) return null;
  const following = args[index + 1];
  if (!following || following.startsWith("-")) throw new Error(`${name} requires a value`);
  return { value: following, consumed: 2 };
}

export function resolveReviewerLaunchOptions(primeArgs: string[], primeAgentDir: string, env: NodeJS.ProcessEnv = process.env): { primeArgs: string[]; policy: ReviewerModelPolicy } {
  const forwarded: string[] = [];
  let cliProvider: string | undefined;
  let cliModel: string | undefined;
  let cliThinking: ReviewerThinkingLevel | undefined;
  let cliInherit = false;
  for (let index = 0; index < primeArgs.length;) {
    if (primeArgs[index] === "--") {
      forwarded.push(...primeArgs.slice(index));
      break;
    }
    if (primeArgs[index] === "--reviewer-inherit-author") { cliInherit = true; index++; continue; }
    const provider = optionValue(primeArgs, index, "--reviewer-provider");
    if (provider) { cliProvider = provider.value; index += provider.consumed; continue; }
    const model = optionValue(primeArgs, index, "--reviewer-model");
    if (model) { cliModel = model.value; index += model.consumed; continue; }
    const thinking = optionValue(primeArgs, index, "--reviewer-thinking");
    if (thinking) { cliThinking = reviewerThinking(thinking.value, "--reviewer-thinking"); index += thinking.consumed; continue; }
    forwarded.push(primeArgs[index]!);
    index++;
  }
  if (cliInherit && (cliProvider || cliModel)) throw new Error("--reviewer-inherit-author cannot be combined with --reviewer-provider/--reviewer-model");
  if (cliProvider || cliModel) {
    if (!cliProvider?.trim() || !cliModel?.trim()) throw new Error("--reviewer-provider and --reviewer-model must be provided together");
    return { primeArgs: forwarded, policy: { mode: "fixed", provider: cliProvider.trim(), model: cliModel.trim(), thinking: cliThinking ?? "medium" } };
  }
  if (cliInherit || cliThinking) return { primeArgs: forwarded, policy: { mode: "inherit", ...(cliThinking ? { thinking: cliThinking } : {}) } };

  const envProvider = env.PI_CAD_REVIEWER_PROVIDER;
  const envModel = env.PI_CAD_REVIEWER_MODEL;
  const envThinking = reviewerThinking(env.PI_CAD_REVIEWER_THINKING, "PI_CAD_REVIEWER_THINKING");
  if (envProvider || envModel) {
    if (!envProvider?.trim() || !envModel?.trim()) throw new Error("PI_CAD_REVIEWER_PROVIDER and PI_CAD_REVIEWER_MODEL must be provided together");
    return { primeArgs: forwarded, policy: { mode: "fixed", provider: envProvider.trim(), model: envModel.trim(), thinking: envThinking ?? "medium" } };
  }
  if (env.PI_CAD_REVIEWER_INHERIT_AUTHOR === "1" || envThinking) {
    return { primeArgs: forwarded, policy: { mode: "inherit", ...(envThinking ? { thinking: envThinking } : {}) } };
  }
  const configPath = join(primeAgentDir, PRIME_CAD_CONFIG_FILE);
  return { primeArgs: forwarded, policy: reviewerPolicyFromConfig(readPrimeCadConfig(primeAgentDir), configPath) };
}

export function reviewerModelArgs(policy: ReviewerModelPolicy, author: ReviewerModelSelection | undefined): string[] {
  const selected = policy.mode === "fixed"
    ? { provider: policy.provider, model: policy.model, thinking: policy.thinking }
    : author && { ...author, thinking: policy.thinking ?? author.thinking };
  if (!selected) throw new Error("reviewer model inheritance is unavailable until Prime reports the current author model");
  return ["--provider", selected.provider, "--model", selected.model, "--thinking", selected.thinking];
}

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

// Prime's CLI requires positive autonomous limits. Max-safe values leave the
// ordinary reviewer free of practical rollout, token, continuation, and time caps.
const REVIEWER_UNBOUNDED_LIMIT = String(Number.MAX_SAFE_INTEGER);

export function resolvePrimeRepository(repository: string, primeAgentDir: string, explicit = process.env.PRIME_AGENT_REPO): string {
  const configPath = join(primeAgentDir, PRIME_CAD_CONFIG_FILE);
  const configuredValue = readPrimeCadConfig(primeAgentDir).primeAgentRepo;
  if (configuredValue !== undefined && (typeof configuredValue !== "string" || !configuredValue.trim())) throw new Error(`Invalid Prime repository configuration at ${configPath}: primeAgentRepo must be a non-empty string`);
  const configured = configuredValue?.trim();
  const candidate = resolve(explicit ?? configured ?? resolve(repository, "../prime-agent"));
  let primeRoot: string;
  try {
    primeRoot = realpathSync(candidate);
  } catch {
    const source = explicit ? "PRIME_AGENT_REPO" : configured ? configPath : "the default sibling checkout";
    throw new Error(`Prime Agent repository from ${source} does not exist: ${candidate}. Run npm run prime:setup with PRIME_AGENT_REPO=/path/to/prime-agent.`);
  }
  if (!existsSync(join(primeRoot, "prime-agent.sh"))) {
    throw new Error(`Prime Agent repository is missing prime-agent.sh: ${primeRoot}`);
  }
  return primeRoot;
}

export function buildReviewerBwrapArgs(paths: LaunchPaths, input: { reviewId: string; reviewerAgentDir: string; reviewerWorkspace: string; reviewerSocketDirectory: string; prompt: string; modelArgs?: string[] }): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime", "--dir", "/opt", "--dir", "/run", "--dir", "/run/pi-cad"];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) systemBind(args, path);
  args.push(
    "--bind", input.reviewerWorkspace, "/workspace",
    "--ro-bind", paths.primeRoot, "/opt/prime", "--ro-bind", paths.nodeRoot, "/opt/node",
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad",
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
    "--setenv", "PYTHONPATH", `/opt/prime-kernel-venv/${paths.kernelSitePackages}:/opt/pi-cad/cad/src`,
    "--setenv", "PRIME_AGENT_REPO", "/opt/prime", "--setenv", "PRIME_AGENT_CODING_AGENT_DIR", "/home/prime/.prime/agent",
    "--setenv", "PRIME_AGENT_KERNEL_PYTHON", `/opt/python/bin/${paths.kernelPythonExecutable}`,
    "--setenv", "PI_OFFLINE", "1",
  );
  for (const name of ["TERM", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"]) passEnvironment(args, name, process.env[name]);
  args.push(
    "--", "/opt/prime/prime-agent.sh", "--dist", "--cwd", "/workspace",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython", ...(input.modelArgs ?? []), "--autonomous",
    "--autonomous-max-continuations", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-max-turns", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-max-tokens", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-timeout-ms", REVIEWER_UNBOUNDED_LIMIT,
    "--no-session", "--mode", "json", "--print", input.prompt,
  );
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
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad",
    "--ro-bind", join(paths.repository, "skills", "grill-me"), "/opt/pi-cad/grill-me",
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
    "--setenv", "PYTHONPATH", `/opt/prime-kernel-venv/${paths.kernelSitePackages}:/opt/pi-cad/cad/src`,
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
    "--", "/opt/prime/prime-agent.sh", "--dist",
    "--cwd", "/workspace",
    "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython,codex_generate_image,cad_experience_search,cad_experience_get,cad_experience_find,cad_experience_read",
    "--extension", "/opt/pi-cad/prime-extension/extension.ts",
    "--extension", "/opt/pi-cad/imagegen/index.ts",
    "--skill", "/opt/pi-cad/cad/SKILL.md",
    "--skill", "/opt/pi-cad/grill-me/SKILL.md",
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

function latestPrimeSession(project: string): string | null {
  const root = join(project, ".prime-sessions");
  if (!existsSync(root)) return null;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  };
  visit(root, 0);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

async function archivePrimeExperience(
  project: string,
  gate: { complete: boolean; outcome?: "complete" | "clarification_required"; reason?: string; runId?: string; workflowId?: string },
  author: ReviewerModelSelection | undefined,
): Promise<void> {
  if (process.env.PI_CAD_EXPERIENCE_ENABLED === "0") return;
  const sessionPath = latestPrimeSession(project);
  if (!sessionPath || !gate.runId) {
    process.stderr.write("[pi-cad] experience archival skipped: run has no persisted Prime session or run id\n");
    return;
  }
  try {
    const entry = await finalizeExperience({
      runId: gate.runId,
      workflow: gate.workflowId,
      projectPath: project,
      sessionPath,
      model: author ? `${author.provider}/${author.model}` : undefined,
      reasoning: author?.thinking,
      outcome: gate.outcome ?? (gate.complete ? "complete" : "incomplete"),
      outcomeReason: gate.reason,
    });
    const markerDirectory = join(project, ".pi-cad");
    await mkdir(markerDirectory, { recursive: true });
    const marker = join(markerDirectory, "experience.json");
    const temporary = `${marker}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schema: 1, seq: entry.seq, sha: entry.sha, root: experienceRoot(), runId: entry.run_id }, null, 2)}\n`, "utf8");
    await rename(temporary, marker);
  } catch (error) {
    process.stderr.write(`[pi-cad] experience archival failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export function withHeadlessEventContinuation(args: string[]): string[] {
  if (!isOneShot(args)) return args;
  const completionCommand = "$PRIME_AGENT_KERNEL_PYTHON -m cad._completion_gate";
  const gate = args.includes(completionCommand) ? [] : [
    "--autonomous-gate", completionCommand,
    "--autonomous-gate-timeout-ms", "5000",
    "--autonomous-gate-retries", process.env.PI_CAD_AUTONOMOUS_GATE_RETRIES || "8",
  ];
  if (args.includes("--autonomous")) return [...gate, ...args];
  // Prime print mode disposes the session after the first provider action.
  // Continuations let an extension-delivered review event become a provider
  // turn. Prime's own gate now consults the same sidecar completion authority,
  // so a terminal release exits without a synthetic follow-up turn.
  return [
    ...gate,
    "--autonomous", "--autonomous-max-continuations", "64",
    "--autonomous-max-turns", "64", "--autonomous-max-tokens", "500000",
    ...args,
  ];
}

async function copyPrimeBootstrap(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "settings.json", "telemetry.json"]) {
    try { await copyFile(join(source, name), join(destination, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/**
 * The author runs in an isolated, per-launch agent directory.  Prime's
 * /login writes auth.json there, so without this handoff API keys disappear
 * as soon as the sandbox is cleaned up.  Merge only credentials back into the
 * durable host directory; settings and session state intentionally remain
 * isolated per project launch.
 */
async function persistPrimeCredentials(source: string, destination: string): Promise<void> {
  const sourcePath = join(source, "auth.json");
  let sourceCredentials: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    sourceCredentials = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const destinationPath = join(destination, "auth.json");
  let destinationCredentials: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(destinationPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      destinationCredentials = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });
  const temporaryPath = join(destination, `auth.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify({ ...destinationCredentials, ...sourceCredentials }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, destinationPath);
}

function childExit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => accept({ code: code ?? 1, signal }));
  });
}

function capturedChildExit(command: string, args: string[], env: NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<{ code: number; signal: NodeJS.Signals | null; diagnostic: string; aborted: boolean }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let diagnostic = "";
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-8192); };
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    child.once("error", (error) => { abortSignal?.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code, signal) => {
      abortSignal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      accept({ code: code ?? 1, signal, diagnostic, aborted });
    });
  });
}

export async function main(primeArgs = process.argv.slice(2)): Promise<number> {
  assertLinuxRuntime("Pi-CAD authority sidecar");
  if (primeArgs.some((value) => value === "--cwd" || value.startsWith("--cwd="))) {
    throw new Error("prime-cad owns --cwd so the sandbox cannot escape its project root");
  }
  const repository = realpathSync(resolve(process.env.PI_CAD_REPO ?? resolve(import.meta.dirname, "..", "..")));
  const project = await realpath(resolve(process.env.PI_CAD_PROJECT_CWD ?? process.cwd()));
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const primeAgentDir = resolve(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime", "agent"));
  const reviewerLaunch = resolveReviewerLaunchOptions(primeArgs, primeAgentDir);
  primeArgs = withHeadlessEventContinuation(reviewerLaunch.primeArgs);
  const primeRoot = resolvePrimeRepository(repository, primeAgentDir);
  process.env.PRIME_AGENT_REPO = primeRoot;
  const primeKernelVenv = resolve(process.env.PRIME_AGENT_KERNEL_VENV ?? join(primeAgentDir, "kernel-venv"));
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
  await mkdir(reviewerWorkspace, { recursive: true, mode: 0o700 });
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = defaultCanonicalProjectDirectory(project);
  await mkdir(process.env.PI_CAD_CANONICAL_PROJECT_DIR, { recursive: true, mode: 0o700 });
  let reviewerSocketDirectory = "";
  let launchPaths!: LaunchPaths;
  let currentAuthorModel: ReviewerModelSelection | undefined;
  const sidecar = await startAuthoritySidecar({
    cwd: project, runtimeDirectory,
    onAuthorModelSelection: (selection) => { currentAuthorModel = selection; },
    reviewerExecutor: async ({ reviewId, prompt, signal }) => {
      // OAuth providers may rotate the refresh token while the author is
      // running. Snapshot the live isolated author bootstrap at admission so
      // a late reviewer never starts with the stale launch-time copy.
      await copyPrimeBootstrap(ephemeralAgentDir, reviewerAgentDir);
      const result = await capturedChildExit("/usr/bin/bwrap", buildReviewerBwrapArgs(launchPaths, { reviewId, reviewerAgentDir, reviewerWorkspace, reviewerSocketDirectory, prompt, modelArgs: reviewerModelArgs(reviewerLaunch.policy, currentAuthorModel) }), { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, signal);
      if (result.aborted) return;
      if (result.code !== 0) {
        const detail = result.diagnostic.trim().split("\n").slice(-3).join(" | ").replace(/[A-Za-z0-9_-]{80,}/g, "[redacted]");
        throw new Error(`reviewer exited with code ${result.code}${detail ? `: ${detail}` : ""}`);
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
		// Persist credentials entered via /login before the runtime directory is
		// removed in finally. This makes provider keys available to future tasks.
		await persistPrimeCredentials(ephemeralAgentDir, primeAgentDir);
    const gate = await completionGate(project);
    await archivePrimeExperience(project, gate, currentAuthorModel);
    if (result.signal) return 128;
    if (!isOneShot(primeArgs)) return result.code;
    if (gate.complete) return 0;
    process.stderr.write(`WORKFLOW_INCOMPLETE: ${gate.reason}\n`);
    return WORKFLOW_INCOMPLETE_EXIT_CODE;
  } finally {
    await sidecar.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}
