import { createHash } from "node:crypto";
import { dirname, extname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { WorkflowGitAction, WorkflowSnapshotV1 } from "../harness/workflow/types.ts";
import { runProcess } from "../shared/process-runner.ts";

const DEFAULT_SOURCE_EXTENSIONS = [".py", ".scad", ".fcstd", ".js", ".mjs", ".ts", ".json", ".yaml", ".yml", ".toml", ".md", ".txt"];

export interface WorkflowGitResult {
  action: "init" | WorkflowGitAction;
  status: "completed" | "skipped";
  revision?: string;
  files?: string[];
  reason?: string;
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  let result;
  try {
    result = await runProcess({ command: "git", args, cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000, maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 8 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return "";
    throw new Error(`Git is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode === 0) return result.stdout;
  if (allowFailure) return "";
  const detail = result.stderr.trim();
  throw new Error(`Git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
}

async function isRepository(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"], true)).trim() === "true";
}

async function changedPaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if ((status.startsWith("R") || status.startsWith("C")) && entries[index + 1]) {
      paths.push(entries[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function sourceFiles(paths: string[], workflow: WorkflowSnapshotV1): string[] {
  const allowed = new Set((workflow.versionControl?.sourceExtensions ?? DEFAULT_SOURCE_EXTENSIONS).map((item) => item.toLowerCase()));
  const ignored = /(^|\/)(?:node_modules|\.venv|venv|__pycache__|dist|\.pi|\.pi-cad|\.prime-sessions)(?:\/|$)/;
  const sensitive = /(^|\/)(?:credentials?|secrets?|tokens?|auth)(?:[._-]|$)/i;
  return paths.filter((path) => !ignored.test(path) && !sensitive.test(path) && allowed.has(extname(path).toLowerCase()));
}

async function baselinePath(cwd: string, workflow: WorkflowSnapshotV1): Promise<string> {
  const projectKey = createHash("sha256").update(`${resolve(cwd)}\0${workflow.hash}`).digest("hex");
  return resolve(cwd, (await git(cwd, ["rev-parse", "--git-dir"])).trim(), "reify", `${projectKey}.baseline.json`);
}

async function writeBaseline(cwd: string, workflow: WorkflowSnapshotV1): Promise<void> {
  const path = await baselinePath(cwd, workflow);
  await mkdir(dirname(path), { recursive: true });
  const entries = await Promise.all((await changedPaths(cwd)).map(async (item) => [item, await fileHash(resolve(cwd, item))] as const));
  await writeFile(path, `${JSON.stringify({ schema: 1, files: Object.fromEntries(entries) })}\n`, { mode: 0o600 });
}

async function fileHash(path: string): Promise<string | null> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); } catch { return null; }
}

async function baselineFiles(cwd: string, workflow: WorkflowSnapshotV1): Promise<Record<string, string | null>> {
  try {
    const parsed = JSON.parse(await readFile(await baselinePath(cwd, workflow), "utf8")) as { files?: unknown };
    return parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files as Record<string, string | null> : {};
  } catch {
    // A restarted process must fail safe: current dirty files are treated as
    // user-owned instead of being swept into an automatic commit.
    await writeBaseline(cwd, workflow);
    return baselineFiles(cwd, workflow);
  }
}

export async function prepareWorkflowGit(cwd: string, workflow: WorkflowSnapshotV1): Promise<WorkflowGitResult[]> {
  const policy = workflow.versionControl;
  if (!policy) return [];
  const results: WorkflowGitResult[] = [];
  if (!(await isRepository(cwd))) {
    if (!policy.init) throw new Error("workflow Git policy requires a repository; enable versionControl.init or initialize Git first");
    await git(cwd, ["init"]);
    results.push({ action: "init", status: "completed" });
    const initialFiles = sourceFiles(await changedPaths(cwd), workflow);
    if (initialFiles.length) {
      await git(cwd, ["add", "--", ...initialFiles]);
      await git(cwd, ["-c", "user.name=Reify", "-c", "user.email=reify@local", "commit", "-m", "reify: initialize project"]);
      results.push({ action: "commit", status: "completed", files: initialFiles, revision: (await git(cwd, ["rev-parse", "HEAD"])).trim() });
    }
  }
  await writeBaseline(cwd, workflow);
  results.push(...await executeWorkflowGitActions(cwd, workflow, policy.onWorkflowStart ?? [], "workflow-start"));
  return results;
}

export async function executeWorkflowGitActions(
  cwd: string,
  workflow: WorkflowSnapshotV1,
  actions: WorkflowGitAction[],
  label: string,
): Promise<WorkflowGitResult[]> {
  if (!actions.length) return [];
  if (!(await isRepository(cwd))) throw new Error("workflow Git action requires an initialized repository");
  const results: WorkflowGitResult[] = [];
  for (const action of actions) {
    if ((action === "pull" || action === "push") && !workflow.versionControl?.allowRemote) {
      throw new Error(`workflow Git ${action} is disabled; set versionControl.allowRemote: true explicitly`);
    }
    if (action === "pull") {
      await git(cwd, ["pull", "--ff-only"]);
      results.push({ action, status: "completed", revision: (await git(cwd, ["rev-parse", "HEAD"])).trim() });
      continue;
    }
    if (action === "push") {
      await git(cwd, ["push"]);
      results.push({ action, status: "completed", revision: (await git(cwd, ["rev-parse", "HEAD"])).trim() });
      continue;
    }
    const staged = (await git(cwd, ["diff", "--cached", "--name-only", "-z"])).trim();
    if (staged) throw new Error("automatic Git commit refused because the user already has staged changes");
    const baseline = await baselineFiles(cwd, workflow);
    const candidates = sourceFiles(await changedPaths(cwd), workflow);
    const changedSinceStart = await Promise.all(candidates.map(async (path) => !(path in baseline) || await fileHash(resolve(cwd, path)) !== baseline[path] ? path : null));
    const files = changedSinceStart.filter((path): path is string => path !== null);
    if (!files.length) {
      results.push({ action, status: "skipped", reason: "no changed source files" });
      continue;
    }
    await git(cwd, ["add", "--", ...files]);
    try {
      await git(cwd, ["-c", "user.name=Reify", "-c", "user.email=reify@local", "commit", "-m", `reify: ${label}`]);
    } catch (error) {
      if ((await git(cwd, ["rev-parse", "HEAD"], true)).trim()) await git(cwd, ["reset", "--mixed", "HEAD"], true);
      else await git(cwd, ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...files], true);
      throw error;
    }
    results.push({ action, status: "completed", files, revision: (await git(cwd, ["rev-parse", "HEAD"])).trim() });
  }
  return results;
}

export function phaseGitActions(workflow: WorkflowSnapshotV1, phase: string, moment: "onEnter" | "onExit"): WorkflowGitAction[] {
  return workflow.versionControl?.phases?.[phase]?.[moment] ?? [];
}

export async function currentGitRevision(cwd: string): Promise<string | undefined> {
  if (!(await isRepository(cwd))) return undefined;
  return (await git(cwd, ["rev-parse", "HEAD"], true)).trim() || undefined;
}
