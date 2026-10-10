import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { gitRevision } from "./child-process.ts";
import { primePythonPath, REVIEWER_UNBOUNDED_LIMIT, type LaunchPaths } from "./prime-config.ts";
import { PROXY_URL_ENVIRONMENT, stripProxyUserinfo, warnProxyCredentialsStripped } from "./proxy-environment.ts";

export function nativeEnvironment(paths: LaunchPaths, agentDir: string, socket: string, reviewer = false): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  let stripped = false;
  for (const name of PROXY_URL_ENVIRONMENT) {
    const value = process.env[name];
    if (value === undefined) continue;
    const sanitized = stripProxyUserinfo(value);
    stripped ||= sanitized.stripped;
    environment[name] = sanitized.value;
  }
  if (stripped) warnProxyCredentialsStripped();
  return {
    ...environment,
    HOME: dirname(dirname(agentDir)), TMPDIR: join(paths.runtimeDirectory, "tmp"),
    PATH: `${process.env.PI_CAD_NODE_WRAPPER ? dirname(process.env.PI_CAD_NODE_WRAPPER) : join(paths.nodeRoot, "bin")}:${paths.primeRoot}:${join(paths.primeRoot, "node_modules", ".bin")}:/usr/local/bin:/usr/bin:/bin`,
    PI_CAD_PROJECT_CWD: reviewer ? join(paths.runtimeDirectory, "reviewer-workspace") : paths.project,
    PI_CAD_REPO: paths.repository,
    PI_CAD_BLENDER_RUNTIME: join(paths.repository, ".runtime", "blender"),
    PI_CAD_BLENDER_MCP_ROOT: join(paths.repository, "third_party", "blender-mcp"),
    BLENDER_MCP_PORT: process.env.PI_CAD_BLENDER_MCP_PORT,
    PI_CAD_PYTHON: join(paths.repository, "python", ".venv", "bin", "python"),
    PYTHONPATH: `${primePythonPath(paths.primeRoot, join(paths.primeKernelVenv, paths.kernelSitePackages), false)}:${join(paths.repository, "third_party", "blender-mcp", "deps")}:${join(paths.repository, "third_party", "blender-mcp", "mcp")}:${join(paths.repository, "skills", "cad", "src")}:${join(paths.repository, "python")}`,
    PYTHONDONTWRITEBYTECODE: "1", PRIME_AGENT_REPO: paths.primeRoot,
    PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_SESSION_DIR: reviewer ? undefined : join(paths.project, ".prime-sessions"),
    PRIME_AGENT_KERNEL_VENV: paths.primeKernelVenv,
    PRIME_AGENT_KERNEL_PYTHON: join(paths.primeKernelVenv, "bin", "python"),
    PRIME_AGENT_GIT_SHA: gitRevision(paths.primeRoot),
    PI_CAD_GIT_SHA: gitRevision(paths.repository),
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

export async function macSandboxCommand(paths: LaunchPaths, command: string, args: string[], readable: string[], writable: string[]): Promise<{ command: string; args: string[] }> {
  const profile = join(paths.runtimeDirectory, `sandbox-${Math.random().toString(16).slice(2)}.sb`);
  await writeFile(profile, macSandboxProfile(readable, writable), { encoding: "utf8", mode: 0o600 });
  return { command: "/usr/bin/sandbox-exec", args: ["-f", profile, command, ...args] };
}

export function nativePrimeArgs(paths: LaunchPaths, primeArgs: string[]): string[] {
  return ["--dist", "--cwd", paths.project, "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython,codex_generate_image,cad_experience_search,cad_experience_get,cad_experience_find,cad_experience_read",
    "--extension", join(paths.repository, "src", "integrations", "prime", "extension.ts"),
    "--extension", join(paths.repository, "packages", "prime-codex-image-gen", "index.ts"),
    "--skill", join(paths.repository, "skills", "cad", "SKILL.md"),
    "--skill", join(paths.repository, "skills", "parametric-cad-modeling", "SKILL.md"),
    "--skill", join(paths.repository, "skills", "assembly-design", "SKILL.md"),
    "--skill", join(paths.repository, "skills", "grill-me", "SKILL.md"),
    "--skill", join(paths.repository, "skills", "blender-product-rendering", "SKILL.md"),
    "--skill", join(paths.repository, "packages", "prime-codex-image-gen", "skills", "imagegen", "SKILL.md"), ...primeArgs];
}

export function nativeReviewerArgs(paths: LaunchPaths, input: { prompt: string; modelArgs?: string[] }): string[] {
  return ["--dist", "--cwd", join(paths.runtimeDirectory, "reviewer-workspace"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython", ...(input.modelArgs ?? []), "--autonomous", "--autonomous-max-continuations", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-max-turns", REVIEWER_UNBOUNDED_LIMIT, "--autonomous-max-tokens", REVIEWER_UNBOUNDED_LIMIT,
    "--autonomous-timeout-ms", REVIEWER_UNBOUNDED_LIMIT, "--no-session", "--mode", "json", "--print", input.prompt];
}
