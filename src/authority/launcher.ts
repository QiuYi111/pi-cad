import { realpathSync, readdirSync, readlinkSync, existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { assertUnixRuntime } from "../shared/platform.ts";
import { HarnessProjectStoreV7 } from "../harness/run-store.ts";
import { archivePrimeExperience } from "../experience/prime-archive.ts";
import { completionGate, completionGateForConversation, startAuthoritySidecar } from "./sidecar.ts";
import { canonicalProjectKey, defaultCanonicalProjectDirectory } from "./storage.ts";
import { childExit, capturedChildExit } from "./child-process.ts";
import { configureBlenderMcp, startManagedBlenderMcp } from "../integrations/blender-mcp.ts";
import { bootstrapPrimeKernel, copyPrimeBootstrap, ensurePrimeAgentFiles, preparePerRunAgentDir } from "./prime-bootstrap.ts";
import { persistPrimeCredentials } from "./prime-credentials.ts";
import { buildPrimeBwrapArgs, buildReviewerBwrapArgs } from "./sandbox-bwrap.ts";
import { macSandboxCommand, nativeEnvironment, nativePrimeArgs, nativeReviewerArgs } from "./sandbox-macos.ts";
import { reviewerModelArgs, resolvePrimeRepository, resolveReviewerLaunchOptions, resolveVenvPythonRoot, type LaunchPaths, type ReviewerModelSelection } from "./prime-config.ts";

export const WORKFLOW_INCOMPLETE_EXIT_CODE = 42;

function isOneShot(args: string[]): boolean {
  if (args.includes("--print") || args.includes("-p")) return true;
  const mode = args.findIndex((value) => value === "--mode");
  return mode >= 0 && ["text", "json"].includes(args[mode + 1] ?? "");
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
  await bootstrapPrimeKernel(primeRoot, primeAgentDir, primeKernelVenv, repository);
  const cadPythonRoot = resolveVenvPythonRoot(join(repository, "python", ".venv", "bin", "python"));
  const kernelPythonPath = join(primeKernelVenv, "bin", "python");
  const kernelPython = realpathSync(kernelPythonPath);
  const kernelPythonTarget = resolve(dirname(kernelPythonPath), readlinkSync(kernelPythonPath));
  const kernelPythonRoot = dirname(dirname(kernelPythonTarget));
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
  await ensurePrimeAgentFiles(primeAgentDir);
  await copyPrimeBootstrap(primeAgentDir, ephemeralAgentDir);
  await copyPrimeBootstrap(primeAgentDir, reviewerAgentDir);
  await preparePerRunAgentDir(ephemeralAgentDir);
  await preparePerRunAgentDir(reviewerAgentDir);
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
      // Snapshot the live author bootstrap at admission so a late reviewer
      // starts from the current settings instead of the launch-time copy.
      // Credentials come from the shared durable directory the sandbox binds.
      await copyPrimeBootstrap(ephemeralAgentDir, reviewerAgentDir);
      await preparePerRunAgentDir(reviewerAgentDir);
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
      // Linux shares the durable credential file with the reviewer. macOS hands
      // the reviewer its own copy, so a token it refreshed has to come back.
      if (process.platform === "darwin") await persistPrimeCredentials(reviewerAgentDir, primeAgentDir);
    },
  });
  const paths: LaunchPaths = {
    repository, project, primeRoot, nodeRoot, primeAgentDir, primeKernelVenv, runtimeDirectory,
    cadPythonRoot, kernelPythonRoot, kernelPythonExecutable, kernelSitePackages,
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
    const launchedAt = new Date().toISOString();
    const previousConversations = (await new HarnessProjectStoreV7(project).load()).state.conversations ?? {};
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
    // Linux writes credentials through the shared directory bind. macOS keeps
    // the per-launch copy, so persist /login there before the runtime directory
    // is removed in finally.
    if (process.platform === "darwin") await persistPrimeCredentials(ephemeralAgentDir, primeAgentDir);
    const conversations = (await new HarnessProjectStoreV7(project).load()).state.conversations ?? {};
    const launchedConversation = Object.entries(conversations)
      .filter(([sessionId, binding]) => binding.boundAt >= launchedAt && binding.runId !== previousConversations[sessionId]?.runId)
      .sort((left, right) => left[1].boundAt.localeCompare(right[1].boundAt))[0]?.[0];
    // A one-shot Prime process owns a conversation-scoped run. The project
    // pointer intentionally stays empty for those runs, so gate against the
    // first run this launch bound (the root session starts before RLM children).
    const gate = launchedConversation
      ? await completionGateForConversation(project, launchedConversation)
      : await completionGate(project);
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
