import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  cadPythonRoot: string;
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
export const REVIEWER_UNBOUNDED_LIMIT = String(Number.MAX_SAFE_INTEGER);
export const PRIME_PYTHON_SKILLS = [
  "agent-message", "agent-observe", "attach-image", "compact", "edit",
  "goal", "refine", "rlm-heartbeat", "websearch",
];

export function primePythonPath(primeRoot: string, kernelSitePackages: string, sandboxed: boolean): string {
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

export function resolveVenvPythonRoot(venvPython: string): string {
  const linkTarget = readlinkSync(venvPython);
  return dirname(dirname(resolve(dirname(venvPython), linkTarget)));
}
