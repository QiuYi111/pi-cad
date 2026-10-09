import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { capturedChildExit, gitRevision } from "./child-process.ts";

/**
 * Prime's FileAuthStorageBackend serializes credential writes with a
 * `proper-lockfile` lock directory next to auth.json and replaces the file
 * atomically through a sibling temp file. Lock, temp file and auth.json only
 * cooperate when all three live in the same shared directory: binding the
 * single auth.json file leaves each run locking its own private directory, and
 * renaming a temp file onto a bind mount point fails with EBUSY. So the whole
 * durable agent directory is the shared namespace, and the entries below are
 * bound back from the per-launch copy to keep settings, sessions, telemetry,
 * and logs isolated per run.
 */
export const PRIME_AGENT_PER_RUN_FILES = ["settings.json", "telemetry.json"] as const;
export const PRIME_AGENT_PER_RUN_DIRECTORIES = ["sessions", "session-artifacts", "session-leases", "logs", "daemon-workers", "kernel-venv", "bin"] as const;

export async function copyPrimeBootstrap(source: string, destination: string): Promise<void> {
  // macOS sandboxes cannot redirect the agent directory, so their per-launch
  // copy still carries auth.json. On Linux the sandbox reads the durable
  // auth.json through the shared directory bind and this copy stays unused.
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "settings.json", "telemetry.json"]) {
    try { await copyFile(join(source, name), join(destination, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/**
 * bwrap refuses to mount a missing source and silently creates a 0444
 * placeholder when only the destination is missing, so every shared file the
 * sandbox binds has to exist first: auth.json (the durable credential), and
 * the settings/telemetry files the per-launch copies are mounted over. Prime
 * writes `{}` itself when a file is missing, so an empty file is the same
 * "nothing configured yet" state it would produce.
 */
export async function ensurePrimeAgentFiles(primeAgentDir: string): Promise<string> {
  const authPath = join(primeAgentDir, "auth.json");
  await mkdir(primeAgentDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", ...PRIME_AGENT_PER_RUN_FILES]) {
    const path = join(primeAgentDir, name);
    if (!existsSync(path)) await writeFile(path, "{}\n", { encoding: "utf8", mode: 0o600 });
  }
  await chmod(authPath, 0o600);
  return authPath;
}

/**
 * The per-launch agent directory only holds the isolated entries; everything
 * else comes from the shared durable directory. Every mount source must exist
 * before bwrap runs.
 */
export async function preparePerRunAgentDir(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const name of PRIME_AGENT_PER_RUN_FILES) {
    const path = join(agentDir, name);
    if (!existsSync(path)) await writeFile(path, "{}\n", { encoding: "utf8", mode: 0o600 });
  }
  for (const name of PRIME_AGENT_PER_RUN_DIRECTORIES) {
    await mkdir(join(agentDir, name), { recursive: true, mode: 0o700 });
  }
}

export async function bootstrapPrimeKernel(primeRoot: string, primeAgentDir: string, primeKernelVenv: string, repository: string): Promise<void> {
  const env = {
    ...process.env,
    PRIME_AGENT_REPO: primeRoot,
    PRIME_AGENT_CODING_AGENT_DIR: primeAgentDir,
    PRIME_AGENT_KERNEL_VENV: primeKernelVenv,
  };
  delete env.PRIME_AGENT_KERNEL_PYTHON;
  const packagedBootstrap = join(primeRoot, "packages", "coding-agent", "dist", "core", "kernel", "bootstrap-cli.js");
  const bootstrapArgs = existsSync(packagedBootstrap)
    ? [packagedBootstrap]
    : [tsxCli(primeRoot), join(primeRoot, "packages", "coding-agent", "src", "core", "kernel", "bootstrap-cli.ts")];
  const result = await capturedChildExit(process.execPath, bootstrapArgs, env);
  if (result.code !== 0) {
    const failure = JSON.stringify({ primeSha: gitRevision(primeRoot), piCadSha: gitRevision(repository), venv: primeKernelVenv, executable: join(primeKernelVenv, "bin", "python"), prefix: "unavailable", stage: "bootstrap" });
    throw new Error(`PRIME_KERNEL_PROVENANCE_FAILURE ${failure}\nPrime kernel bootstrap failed: ${result.diagnostic.trim() || `exit code ${result.code}`}`);
  }
  const python = join(primeKernelVenv, "bin", "python");
  const provenance = await capturedChildExit(python, ["-c", KERNEL_PROVENANCE], {
    ...env, PRIME_AGENT_KERNEL_PYTHON: python,
    PRIME_AGENT_GIT_SHA: gitRevision(primeRoot), PI_CAD_GIT_SHA: gitRevision(repository),
  });
  process.stderr.write(`${result.diagnostic}${provenance.diagnostic}`);
  if (provenance.code !== 0) {
    throw new Error(`Prime kernel venv provenance check failed for ${primeKernelVenv}: ${provenance.diagnostic.trim() || `exit code ${provenance.code}`}`);
  }
}

function tsxCli(primeRoot: string): string {
  const cli = join(primeRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) throw new Error(`Prime kernel bootstrap needs the tsx CLI to run the TypeScript bootstrap, but it is missing: ${cli}`);
  return cli;
}

export const KERNEL_PROVENANCE = [
  "import json,os,sys",
  "venv=os.environ.get('PRIME_AGENT_KERNEL_VENV')",
  "print('PRIME_KERNEL_PROVENANCE '+json.dumps({'primeSha':os.environ.get('PRIME_AGENT_GIT_SHA'),'piCadSha':os.environ.get('PI_CAD_GIT_SHA'),'venv':venv,'executable':sys.executable,'prefix':sys.prefix,'path':sys.path},sort_keys=True),flush=True)",
  "assert venv and os.path.realpath(sys.prefix)==os.path.realpath(venv), 'kernel sys.prefix does not match PRIME_AGENT_KERNEL_VENV'",
  "import pydantic,rlm,ipykernel",
  "print('PRIME_KERNEL_IMPORTS '+json.dumps({'pydantic':pydantic.__file__,'rlm':rlm.__file__,'ipykernel':ipykernel.__file__},sort_keys=True),flush=True)",
].join(";");
