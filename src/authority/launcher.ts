import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";

import { assertUnixRuntime } from "../shared/platform.ts";
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
  nodeExecutableRelative?: string;
}

// Prime's CLI requires positive autonomous limits. Max-safe values leave the
// ordinary reviewer free of practical rollout, token, continuation, and time caps.
const REVIEWER_UNBOUNDED_LIMIT = String(Number.MAX_SAFE_INTEGER);
const PRIME_PYTHON_SKILLS = [
  "agent-message", "agent-observe", "attach-image", "compact", "edit",
  "goal", "refine", "rlm-heartbeat", "websearch",
];

function primePythonPath(primeRoot: string, kernelSitePackages: string, sandboxed: boolean): string {
  const root = sandboxed ? "/opt/prime" : primeRoot;
  const sitePackages = sandboxed ? `/opt/prime-kernel-venv/${kernelSitePackages}` : kernelSitePackages;
  return [
    sitePackages,
    ...PRIME_PYTHON_SKILLS.map((name) => join(root, "packages", "coding-agent", "dist", "skills", name, "src")),
  ].join(":");
}

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
    "--dir", "/opt/node-bin", "--symlink", `/opt/node/${paths.nodeExecutableRelative ?? "bin/node"}`, "/opt/node-bin/node",
    "--ro-bind", paths.primeRoot, "/opt/prime", "--ro-bind", paths.nodeRoot, "/opt/node",
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad",
    "--ro-bind", join(paths.repository, "python"), "/opt/pi-cad/python",
    "--ro-bind", join(paths.repository, "scripts"), "/opt/pi-cad/scripts",
    "--ro-bind", join(paths.repository, "node_modules"), "/opt/pi-cad/node_modules",
    "--ro-bind", paths.primeKernelVenv, "/opt/prime-kernel-venv", "--ro-bind", paths.kernelPythonRoot, "/opt/python",
    "--bind", input.reviewerAgentDir, "/home/prime/.prime/agent",
    "--ro-bind", input.reviewerSocketDirectory, "/run/pi-cad/reviewer",
    "--chdir", "/workspace",
    "--setenv", "HOME", "/home/prime", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/opt/node-bin:/opt/prime:/opt/prime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "ELECTRON_RUN_AS_NODE", process.env.ELECTRON_RUN_AS_NODE ?? "",
    "--setenv", "PI_CAD_REVIEWER_SOCKET", "/run/pi-cad/reviewer/authority.sock",
    "--setenv", "PI_CAD_REVIEW_ID", input.reviewId,
    "--setenv", "PI_CAD_REVIEWER_MODE", "1", "--setenv", "PI_CAD_PROJECT_CWD", "/workspace",
    "--setenv", "PI_CAD_REPO", "/opt/pi-cad", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    "--setenv", "PYTHONPATH", `${primePythonPath(paths.primeRoot, paths.kernelSitePackages, true)}:/opt/pi-cad/cad/src:/opt/pi-cad/python`,
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

export function buildPrimeBwrapArgs(paths: LaunchPaths, primeArgs: string[], permission: "workspace" | "read-only" = "workspace"): string[] {
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime",
    "--dir", "/opt", "--dir", "/run", "--dir", "/run/pi-cad",
  ];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) systemBind(args, path);
  const blenderRuntime = join(paths.repository, ".runtime", "blender");
  if (existsSync(blenderRuntime)) args.push("--ro-bind", blenderRuntime, "/opt/pi-cad/blender-runtime");
  else args.push("--dir", "/opt/pi-cad/blender-runtime");
  args.push(
    permission === "read-only" ? "--ro-bind" : "--bind", paths.project, "/workspace",
    "--dir", "/opt/node-bin", "--symlink", `/opt/node/${paths.nodeExecutableRelative ?? "bin/node"}`, "/opt/node-bin/node",
    "--ro-bind", paths.primeRoot, "/opt/prime",
    "--ro-bind", paths.nodeRoot, "/opt/node",
    "--ro-bind", join(paths.repository, "src", "integrations", "prime"), "/opt/pi-cad/prime-extension",
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad",
    "--ro-bind", join(paths.repository, "skills", "grill-me"), "/opt/pi-cad/grill-me",
    "--ro-bind", join(paths.repository, "skills", "blender-product-rendering"), "/opt/pi-cad/blender-product-rendering",
    "--ro-bind", join(paths.repository, "third_party", "blender-mcp"), "/opt/pi-cad/blender-mcp",
    "--ro-bind", join(paths.repository, "python"), "/opt/pi-cad/python",
    "--ro-bind", join(paths.repository, "scripts"), "/opt/pi-cad/scripts",
    "--ro-bind", join(paths.repository, "packages", "prime-codex-image-gen"), "/opt/pi-cad/imagegen",
    "--ro-bind", join(paths.repository, "node_modules"), "/opt/pi-cad/node_modules",
    "--ro-bind", paths.primeKernelVenv, "/opt/prime-kernel-venv",
    "--ro-bind", paths.kernelPythonRoot, "/opt/python",
    "--bind", paths.ephemeralAgentDir, "/home/prime/.prime/agent",
    "--ro-bind", paths.authorSocketDirectory, "/run/pi-cad/author",
    "--chdir", "/workspace",
    "--setenv", "HOME", "/home/prime",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/opt/node-bin:/opt/prime:/opt/prime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "ELECTRON_RUN_AS_NODE", process.env.ELECTRON_RUN_AS_NODE ?? "",
    "--setenv", "PI_CAD_AUTHOR_SOCKET", "/run/pi-cad/author/authority.sock",
    "--setenv", "PI_CAD_PROJECT_CWD", "/workspace",
    "--setenv", "PI_CAD_REPO", "/opt/pi-cad",
    "--setenv", "PI_CAD_BLENDER_RUNTIME", "/opt/pi-cad/blender-runtime",
    "--setenv", "PI_CAD_BLENDER_MCP_ROOT", "/opt/pi-cad/blender-mcp",
    "--setenv", "BLENDER_MCP_PORT", process.env.PI_CAD_BLENDER_MCP_PORT ?? "9876",
    "--setenv", "PI_CAD_PYTHON", "/opt/pi-cad/python/.venv/bin/python",
    "--setenv", "PYTHONPATH", `/opt/pi-cad/blender-mcp/deps:/opt/pi-cad/blender-mcp/mcp:${primePythonPath(paths.primeRoot, paths.kernelSitePackages, true)}:/opt/pi-cad/cad/src:/opt/pi-cad/python`,
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
    "--skill", "/opt/pi-cad/blender-product-rendering/SKILL.md",
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

async function configureBlenderMcp(agentDir: string, command: string, env: Record<string, { env: string }>): Promise<void> {
  const path = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const current = settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)
    ? settings.mcpServers as Record<string, unknown> : {};
  settings.mcpServers = {
    ...current,
    blender: { type: "stdio", command, args: [], env, startupTimeoutMs: 20_000, callTimeoutMs: 300_000 },
  };
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function freeTcpPort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate Blender MCP port"));
      server.close((error) => error ? reject(error) : accept(address.port));
    });
  });
}

async function waitForTcp(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`managed Blender MCP exited with code ${child.exitCode}`);
    const connected = await new Promise<boolean>((accept) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); accept(true); });
      socket.once("timeout", () => { socket.destroy(); accept(false); });
      socket.once("error", () => accept(false));
    });
    if (connected) return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("managed Blender MCP did not become ready within 30 seconds");
}

async function startManagedBlenderMcp(repository: string): Promise<{ close: () => Promise<void> } | null> {
  const manifest = JSON.parse(await readFile(join(repository, "scripts", "blender-manifest.json"), "utf8")) as { version: string; platforms: Record<string, { binary?: string }> };
  const key = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  const entry = manifest.platforms[key];
  if (!entry?.binary) return null;
  const binary = join(repository, ".runtime", "blender", manifest.version, key, "blender");
  if (!existsSync(binary)) return null;
  const port = await freeTcpPort();
  process.env.PI_CAD_BLENDER_MCP_PORT = String(port);
  const addon = join(repository, "third_party", "blender-mcp", "addon");
  const expression = `import sys;sys.path.insert(0,${JSON.stringify(addon)});import blender_mcp_addon;blender_mcp_addon.register()`;
  const runtimeDir = dirname(binary);
  const child = spawn(binary, ["--background", "--factory-startup", "--online-mode", "--python-expr", expression, "--command", "blender_mcp", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, OMP_NUM_THREADS: "1", LD_LIBRARY_PATH: [join(runtimeDir, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
  });
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-4096); });
  try { await waitForTcp(port, child); }
  catch (error) { child.kill("SIGTERM"); throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic ? `: ${diagnostic.trim()}` : ""}`); }
  return { close: () => new Promise((accept) => {
    if (child.exitCode !== null) return accept();
    child.once("exit", () => accept());
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000).unref();
  }) };
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

function nativeEnvironment(paths: LaunchPaths, agentDir: string, socket: string, reviewer = false): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dirname(dirname(agentDir)), TMPDIR: join(paths.runtimeDirectory, "tmp"),
    PATH: `${process.env.PI_CAD_NODE_WRAPPER ? dirname(process.env.PI_CAD_NODE_WRAPPER) : join(paths.nodeRoot, "bin")}:${paths.primeRoot}:${join(paths.primeRoot, "node_modules", ".bin")}:/usr/local/bin:/usr/bin:/bin`,
    PI_CAD_PROJECT_CWD: reviewer ? join(paths.runtimeDirectory, "reviewer-workspace") : paths.project,
    PI_CAD_REPO: paths.repository,
    PI_CAD_BLENDER_RUNTIME: join(paths.repository, ".runtime", "blender"),
    PI_CAD_BLENDER_MCP_ROOT: join(paths.repository, "third_party", "blender-mcp"),
    BLENDER_MCP_PORT: process.env.PI_CAD_BLENDER_MCP_PORT,
    PI_CAD_PYTHON: join(paths.repository, "python", ".venv", "bin", "python"),
    PYTHONPATH: `${join(paths.repository, "third_party", "blender-mcp", "deps")}:${join(paths.repository, "third_party", "blender-mcp", "mcp")}:${primePythonPath(paths.primeRoot, join(paths.primeKernelVenv, paths.kernelSitePackages), false)}:${join(paths.repository, "skills", "cad", "src")}:${join(paths.repository, "python")}`,
    PYTHONDONTWRITEBYTECODE: "1", PRIME_AGENT_REPO: paths.primeRoot,
    PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_SESSION_DIR: reviewer ? undefined : join(paths.project, ".prime-sessions"),
    PRIME_AGENT_KERNEL_PYTHON: join(paths.kernelPythonRoot, "bin", paths.kernelPythonExecutable),
    PI_OFFLINE: reviewer ? "1" : process.env.PI_OFFLINE ?? "1",
    ...(reviewer ? { PI_CAD_REVIEWER_SOCKET: socket, PI_CAD_REVIEWER_MODE: "1" } : { PI_CAD_AUTHOR_SOCKET: socket }),
  };
}

function macSandboxProfile(readable: string[], writable: string[]): string {
  const literal = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    "(version 1)", "(allow default)", "(deny file-write*)",
    `(deny file-read* (subpath \"${literal(homedir())}\"))`,
    ...readable.map((path) => `(allow file-read* (subpath \"${literal(path)}\"))`),
    ...writable.map((path) => `(allow file-write* (subpath \"${literal(path)}\"))`),
  ].join("\n");
}

async function macSandboxCommand(paths: LaunchPaths, command: string, args: string[], readable: string[], writable: string[]): Promise<{ command: string; args: string[] }> {
  const profile = join(paths.runtimeDirectory, `sandbox-${Math.random().toString(16).slice(2)}.sb`);
  await writeFile(profile, macSandboxProfile(readable, writable), { encoding: "utf8", mode: 0o600 });
  return { command: "/usr/bin/sandbox-exec", args: ["-f", profile, command, ...args] };
}

function nativePrimeArgs(paths: LaunchPaths, primeArgs: string[]): string[] {
  return ["--dist", "--cwd", paths.project, "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython,codex_generate_image,cad_experience_search,cad_experience_get,cad_experience_find,cad_experience_read",
    "--extension", join(paths.repository, "src", "integrations", "prime", "extension.ts"),
    "--extension", join(paths.repository, "packages", "prime-codex-image-gen", "index.ts"),
    "--skill", join(paths.repository, "skills", "cad", "SKILL.md"),
    "--skill", join(paths.repository, "skills", "grill-me", "SKILL.md"),
    "--skill", join(paths.repository, "skills", "blender-product-rendering", "SKILL.md"),
    "--skill", join(paths.repository, "packages", "prime-codex-image-gen", "skills", "imagegen", "SKILL.md"), ...primeArgs];
}

function nativeReviewerArgs(paths: LaunchPaths, input: { prompt: string; modelArgs?: string[] }): string[] {
  return ["--dist", "--cwd", join(paths.runtimeDirectory, "reviewer-workspace"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython", ...(input.modelArgs ?? []), "--autonomous", "--autonomous-max-continuations", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-max-turns", REVIEWER_UNBOUNDED_LIMIT, "--autonomous-max-tokens", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-timeout-ms", REVIEWER_UNBOUNDED_LIMIT, "--no-session", "--mode", "json", "--print", input.prompt];
}

export async function main(primeArgs = process.argv.slice(2)): Promise<number> {
  assertUnixRuntime("Pi-CAD authority sidecar");
  if (primeArgs.some((value) => value === "--cwd" || value.startsWith("--cwd="))) {
    throw new Error("prime-cad owns --cwd so the sandbox cannot escape its project root");
  }
  const repository = realpathSync(resolve(process.env.PI_CAD_REPO ?? resolve(import.meta.dirname, "..", "..")));
  const project = await realpath(resolve(process.env.PI_CAD_PROJECT_CWD ?? process.cwd()));
  const nodeExecutable = realpathSync(process.execPath);
  const electronNode = process.env.ELECTRON_RUN_AS_NODE === "1";
  const nodeRoot = electronNode
    ? (process.platform === "darwin" ? dirname(dirname(nodeExecutable)) : dirname(nodeExecutable))
    : dirname(dirname(nodeExecutable));
  const nodeExecutableRelative = electronNode ? nodeExecutable.slice(nodeRoot.length + 1) : "bin/node";
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
    authorReadOnly: process.env.PI_CAD_DESKTOP_PERMISSION === "read-only",
    onAuthorModelSelection: (selection) => { currentAuthorModel = selection; },
    reviewerExecutor: async ({ reviewId, prompt, signal }) => {
      // OAuth providers may rotate the refresh token while the author is
      // running. Snapshot the live isolated author bootstrap at admission so
      // a late reviewer never starts with the stale launch-time copy.
      await copyPrimeBootstrap(ephemeralAgentDir, reviewerAgentDir);
      const modelArgs = reviewerModelArgs(reviewerLaunch.policy, currentAuthorModel);
      const result = process.platform === "darwin"
        ? await (async () => {
            const socket = join(reviewerSocketDirectory, "authority.sock");
            const readable = [paths.primeRoot, paths.primeKernelVenv, paths.nodeRoot, join(paths.repository, "skills", "cad"), reviewerWorkspace, reviewerAgentDir, runtimeDirectory];
            const launch = await macSandboxCommand(launchPaths, join(paths.primeRoot, "prime-agent.sh"), nativeReviewerArgs(paths, { prompt, modelArgs }), readable, [reviewerWorkspace, reviewerAgentDir, runtimeDirectory]);
            return capturedChildExit(launch.command, launch.args, { ...nativeEnvironment(paths, reviewerAgentDir, socket, true), PI_CAD_REVIEW_ID: reviewId }, signal);
          })()
        : await capturedChildExit("/usr/bin/bwrap", buildReviewerBwrapArgs(launchPaths, { reviewId, reviewerAgentDir, reviewerWorkspace, reviewerSocketDirectory, prompt, modelArgs }), { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, signal);
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
    ephemeralAgentDir, authorSocketDirectory: resolve(sidecar.authorSocket, ".."), nodeExecutableRelative,
  };
  launchPaths = paths;
  reviewerSocketDirectory = resolve(sidecar.reviewerSocket, "..");
  const blenderMcp = process.platform === "linux" ? await startManagedBlenderMcp(repository) : null;
  await configureBlenderMcp(
    ephemeralAgentDir,
    process.platform === "darwin" ? join(repository, "scripts", "blender-mcp-server.sh") : "/opt/pi-cad/scripts/blender-mcp-server.sh",
    {
      PRIME_AGENT_KERNEL_PYTHON: { env: "PRIME_AGENT_KERNEL_PYTHON" },
      PI_CAD_BLENDER_MCP_ROOT: { env: "PI_CAD_BLENDER_MCP_ROOT" },
      BLENDER_MCP_PORT: { env: "BLENDER_MCP_PORT" },
    },
  );
  try {
    const result = process.platform === "darwin"
      ? await (async () => {
          const socket = join(paths.authorSocketDirectory, "authority.sock");
          // Canonical workflow state belongs to the sidecar. The author may
          // read its projection but must never write the authority store.
          const writable = [runtimeDirectory, ephemeralAgentDir, ...(process.env.PI_CAD_DESKTOP_PERMISSION === "read-only" ? [] : [project])];
          const readable = [paths.repository, paths.project, paths.primeRoot, paths.primeKernelVenv, paths.nodeRoot, paths.primeAgentDir, runtimeDirectory, process.env.PI_CAD_CANONICAL_PROJECT_DIR!];
          const launch = await macSandboxCommand(paths, join(paths.primeRoot, "prime-agent.sh"), nativePrimeArgs(paths, primeArgs), readable, writable);
          return childExit(launch.command, launch.args, nativeEnvironment(paths, ephemeralAgentDir, socket));
        })()
      : await childExit("/usr/bin/bwrap", buildPrimeBwrapArgs(paths, primeArgs, process.env.PI_CAD_DESKTOP_PERMISSION === "read-only" ? "read-only" : "workspace"), {
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
    await blenderMcp?.close();
    await sidecar.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}
