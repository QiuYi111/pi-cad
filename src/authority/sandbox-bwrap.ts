import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { gitRevision } from "./child-process.ts";
import { KERNEL_PROVENANCE, PRIME_AGENT_PER_RUN_DIRECTORIES, PRIME_AGENT_PER_RUN_FILES } from "./prime-bootstrap.ts";
import { primePythonPath, REVIEWER_UNBOUNDED_LIMIT, type LaunchPaths } from "./prime-config.ts";
import { PROXY_URL_ENVIRONMENT, stripProxyUserinfo, warnProxyCredentialsStripped } from "./proxy-environment.ts";

function bindSharedAgentDirectory(args: string[], perRunAgentDir: string, primeAgentDir: string): void {
  args.push("--bind", primeAgentDir, "/home/prime/.prime/agent");
  for (const name of PRIME_AGENT_PER_RUN_FILES) {
    args.push("--bind", join(perRunAgentDir, name), `/home/prime/.prime/agent/${name}`);
  }
  for (const name of PRIME_AGENT_PER_RUN_DIRECTORIES) {
    args.push("--bind", join(perRunAgentDir, name), `/home/prime/.prime/agent/${name}`);
  }
}

/** The agent-directory mounts only, so a sandbox can be assembled around them. */
export function primeAgentMounts(perRunAgentDir: string, primeAgentDir: string): string[] {
  const args: string[] = [];
  bindSharedAgentDirectory(args, perRunAgentDir, primeAgentDir);
  return args;
}

export function buildReviewerBwrapArgs(paths: LaunchPaths, input: { reviewId: string; reviewerAgentDir: string; reviewerWorkspace: string; reviewerSocketDirectory: string; prompt: string; modelArgs?: string[] }): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime", "--dir", "/opt", "--dir", "/run", "--dir", "/run/pi-cad"];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) systemBind(args, path);
  bindKernelPythonRoot(args, paths);
  bindAtOriginalPath(args, paths.cadPythonRoot);
  args.push(
    "--bind", input.reviewerWorkspace, "/workspace",
    "--dir", "/opt/node-bin", "--symlink", `/opt/node/${paths.nodeExecutableRelative ?? "bin/node"}`, "/opt/node-bin/node",
    "--ro-bind", paths.primeRoot, "/opt/prime", "--ro-bind", paths.nodeRoot, "/opt/node",
    "--ro-bind", join(paths.repository, "skills", "cad"), "/opt/pi-cad/cad",
    "--ro-bind", join(paths.repository, "python"), "/opt/pi-cad/python",
    "--ro-bind", join(paths.repository, "scripts"), "/opt/pi-cad/scripts",
    "--ro-bind", join(paths.repository, "node_modules"), "/opt/pi-cad/node_modules",
    "--ro-bind", paths.primeKernelVenv, "/opt/prime-kernel-venv",
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
    "--setenv", "PRIME_AGENT_KERNEL_VENV", "/opt/prime-kernel-venv",
    "--setenv", "PRIME_AGENT_KERNEL_PYTHON", "/opt/prime-kernel-venv/bin/python",
    "--setenv", "PRIME_AGENT_GIT_SHA", gitRevision(paths.primeRoot), "--setenv", "PI_CAD_GIT_SHA", gitRevision(paths.repository),
    "--setenv", "PI_OFFLINE", "1",
  );
  bindSharedAgentDirectory(args, input.reviewerAgentDir, paths.primeAgentDir);
  passEnvironment(args, "TERM", process.env.TERM);
  passEnvironment(args, "LANG", process.env.LANG);
  forwardProxyEnvironment(args);
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

function bindKernelPythonRoot(args: string[], paths: LaunchPaths): void {
  const root = paths.kernelPythonRoot;
  if (["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((systemRoot) => root === systemRoot || root.startsWith(`${systemRoot}/`))) return;
  const parents: string[] = [];
  for (let parent = dirname(root); parent !== "/"; parent = dirname(parent)) parents.push(parent);
  for (const parent of parents.reverse()) {
    if (["/home", "/opt", "/run", "/tmp"].includes(parent)) continue;
    args.push("--dir", parent);
  }
  args.push("--ro-bind", root, root);
}

function bindAtOriginalPath(args: string[], path: string): void {
  const parents: string[] = [];
  for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) parents.push(parent);
  for (const parent of parents.reverse()) args.push("--dir", parent);
  args.push("--ro-bind", path, path);
}

function passEnvironment(args: string[], name: string, value: string | undefined): void {
  if (value !== undefined && value !== "") args.push("--setenv", name, value);
}

function forwardProxyEnvironment(args: string[], environment: NodeJS.ProcessEnv = process.env): void {
  let stripped = false;
  for (const name of PROXY_URL_ENVIRONMENT) {
    const value = environment[name];
    if (value === undefined) continue;
    const sanitized = stripProxyUserinfo(value);
    stripped ||= sanitized.stripped;
    passEnvironment(args, name, sanitized.value);
  }
  if (stripped) warnProxyCredentialsStripped();
  passEnvironment(args, "NO_PROXY", environment.NO_PROXY);
  passEnvironment(args, "no_proxy", environment.no_proxy);
}

export function buildPrimeBwrapArgs(paths: LaunchPaths, primeArgs: string[], permission: "workspace" | "read-only" = "workspace"): string[] {
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime",
    "--dir", "/opt", "--dir", "/run", "--dir", "/run/pi-cad",
  ];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) systemBind(args, path);
  bindKernelPythonRoot(args, paths);
  bindAtOriginalPath(args, paths.cadPythonRoot);
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
    "--ro-bind", join(paths.repository, "skills", "parametric-cad-modeling"), "/opt/pi-cad/skills/parametric-cad-modeling",
    "--ro-bind", join(paths.repository, "skills", "assembly-design"), "/opt/pi-cad/skills/assembly-design",
    "--ro-bind", join(paths.repository, "skills", "grill-me"), "/opt/pi-cad/grill-me",
    "--ro-bind", join(paths.repository, "skills", "blender-product-rendering"), "/opt/pi-cad/blender-product-rendering",
    "--ro-bind", join(paths.repository, "third_party", "blender-mcp"), "/opt/pi-cad/blender-mcp",
    "--ro-bind", join(paths.repository, "python"), "/opt/pi-cad/python",
    "--ro-bind", join(paths.repository, "scripts"), "/opt/pi-cad/scripts",
    "--ro-bind", join(paths.repository, "packages", "prime-codex-image-gen"), "/opt/pi-cad/imagegen",
    "--ro-bind", join(paths.repository, "node_modules"), "/opt/pi-cad/node_modules",
    "--ro-bind", paths.primeKernelVenv, "/opt/prime-kernel-venv",
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
    "--setenv", "PYTHONPATH", `${primePythonPath(paths.primeRoot, paths.kernelSitePackages, true)}:/opt/pi-cad/blender-mcp/deps:/opt/pi-cad/blender-mcp/mcp:/opt/pi-cad/cad/src:/opt/pi-cad/python`,
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    "--setenv", "PRIME_AGENT_REPO", "/opt/prime",
    "--setenv", "PRIME_AGENT_CODING_AGENT_DIR", "/home/prime/.prime/agent",
    "--setenv", "PRIME_AGENT_SESSION_DIR", "/workspace/.prime-sessions",
    "--setenv", "PRIME_AGENT_KERNEL_VENV", "/opt/prime-kernel-venv",
    "--setenv", "PRIME_AGENT_KERNEL_PYTHON", "/opt/prime-kernel-venv/bin/python",
    "--setenv", "PRIME_AGENT_GIT_SHA", gitRevision(paths.primeRoot), "--setenv", "PI_CAD_GIT_SHA", gitRevision(paths.repository),
    "--setenv", "PI_OFFLINE", process.env.PI_OFFLINE ?? "1",
  );
  bindSharedAgentDirectory(args, paths.ephemeralAgentDir, paths.primeAgentDir);
  for (const name of ["TERM", "COLORTERM", "LANG", "LC_ALL"]) passEnvironment(args, name, process.env[name]);
  forwardProxyEnvironment(args);
  args.push(
    "--", "/bin/sh", "-c", '"$1" -c "$2" || { printf "PRIME_KERNEL_PROVENANCE_FAILURE prime=%s pi_cad=%s venv=%s executable=%s prefix=unavailable\\n" "$PRIME_AGENT_GIT_SHA" "$PI_CAD_GIT_SHA" "$PRIME_AGENT_KERNEL_VENV" "$1" >&2; exit 1; }; shift 2; exec "$@"',
    "prime-kernel-provenance", "/opt/prime-kernel-venv/bin/python", KERNEL_PROVENANCE,
    "/opt/prime/prime-agent.sh", "--dist",
    "--cwd", "/workspace",
    "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "ipython,codex_generate_image,cad_experience_search,cad_experience_get,cad_experience_find,cad_experience_read",
    "--extension", "/opt/pi-cad/prime-extension/extension.ts",
    "--extension", "/opt/pi-cad/imagegen/index.ts",
    "--skill", "/opt/pi-cad/cad/SKILL.md",
    "--skill", "/opt/pi-cad/skills/parametric-cad-modeling/SKILL.md",
    "--skill", "/opt/pi-cad/skills/assembly-design/SKILL.md",
    "--skill", "/opt/pi-cad/grill-me/SKILL.md",
    "--skill", "/opt/pi-cad/blender-product-rendering/SKILL.md",
    "--skill", "/opt/pi-cad/imagegen/skills/imagegen/SKILL.md",
    ...primeArgs,
  );
  return args;
}
