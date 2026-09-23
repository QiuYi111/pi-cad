import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  buildPrimeBwrapArgs,
  buildReviewerBwrapArgs,
  ensurePrimeAgentFiles,
  mergePrimeCredentials,
  preparePerRunAgentDir,
  primeAgentMounts,
  resolvePrimeRepository,
  PRIME_AGENT_PER_RUN_DIRECTORIES,
  PRIME_AGENT_PER_RUN_FILES,
  type LaunchPaths,
} from "../src/authority/launcher.ts";

const paths: LaunchPaths = {
  repository: "/repo/pi-cad",
  project: "/project",
  primeRoot: "/repo/prime",
  nodeRoot: "/runtime/node",
  primeAgentDir: "/host/agent",
  primeKernelVenv: "/host/kernel",
  cadPythonRoot: "/runtime/cad-python",
  kernelPythonRoot: "/runtime/python",
  kernelPythonExecutable: "python3.11",
  kernelSitePackages: "lib/python3.11/site-packages",
  runtimeDirectory: "/run/private",
  ephemeralAgentDir: "/run/private/prime-agent",
  authorSocketDirectory: "/run/private/author",
};

const oauth = (access: string, refresh: string, expires: number) => ({ type: "oauth", access, refresh, expires, accountId: "acct_1" });

test("Prime and reviewer sandboxes share the durable agent directory and isolate the rest", () => {
  const author = buildPrimeBwrapArgs(paths, ["--print", "build it"]).join("\n");
  // auth.json, the proper-lockfile lock directory and Prime's sibling temp file
  // all have to live in one directory, so the whole agent directory is shared
  // instead of the credential file alone.
  assert.match(author, /--bind\n\/host\/agent\n\/home\/prime\/\.prime\/agent/);
  assert.doesNotMatch(author, /--bind\n\/host\/agent\/auth\.json\n/);
  for (const name of [...PRIME_AGENT_PER_RUN_FILES, ...PRIME_AGENT_PER_RUN_DIRECTORIES]) {
    const escaped = name.replace(/\./g, "\\.");
    assert.match(author, new RegExp(`--bind\\n/run/private/prime-agent/${escaped}\\n/home/prime/\\.prime/agent/${escaped}`));
  }
  // The shared directory must be mounted before the per-run entries are bound over it.
  assert.ok(author.indexOf("--bind\n/host/agent\n") < author.indexOf("--bind\n/run/private/prime-agent/settings.json\n"));

  const reviewer = buildReviewerBwrapArgs(paths, {
    reviewId: "review-123",
    reviewerAgentDir: "/run/private/reviewer-agent",
    reviewerWorkspace: "/run/private/reviewer-workspace",
    reviewerSocketDirectory: "/run/private/reviewer",
    prompt: "review exactly one commit",
  }).join("\n");
  assert.match(reviewer, /--bind\n\/host\/agent\n\/home\/prime\/\.prime\/agent/);
  assert.doesNotMatch(reviewer, /--bind\n\/host\/agent\/auth\.json\n/);
  assert.match(reviewer, /--bind\n\/run\/private\/reviewer-agent\/settings\.json\n\/home\/prime\/\.prime\/agent\/settings\.json/);
});

test("a per-launch agent directory holds only the isolated entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-per-run-agent-"));
  try {
    const agentDir = join(root, "agent");
    await preparePerRunAgentDir(agentDir);
    for (const name of PRIME_AGENT_PER_RUN_FILES) {
      assert.equal(await readFile(join(agentDir, name), "utf8"), "{}\n");
      assert.equal((await stat(join(agentDir, name))).mode & 0o777, 0o600);
    }
    for (const name of PRIME_AGENT_PER_RUN_DIRECTORIES) {
      assert.equal((await stat(join(agentDir, name))).isDirectory(), true);
    }
    // auth.json is never copied per launch: the sandbox reads the durable one.
    assert.equal(existsSync(join(agentDir, "auth.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run's stale credentials never overwrite a token another run already refreshed", () => {
  const spent = oauth("old-access", "spent-refresh", 1_700_000_000_000);
  const fresh = oauth("new-access", "fresh-refresh", 1_700_000_900_000);
  const durable = { "openai-codex": fresh, zai: { type: "api_key", key: "zai-key" } };

  const afterStaleRun = mergePrimeCredentials({ "openai-codex": spent }, durable);
  assert.deepEqual(afterStaleRun["openai-codex"], fresh);
  assert.deepEqual(afterStaleRun.zai, durable.zai);

  const afterRefresh = mergePrimeCredentials({ "openai-codex": oauth("newer-access", "newer-refresh", 1_700_001_800_000) }, durable);
  assert.deepEqual(afterRefresh["openai-codex"], oauth("newer-access", "newer-refresh", 1_700_001_800_000));
  assert.deepEqual(afterRefresh.zai, durable.zai);
});

test("merging credentials keeps both sides and still lets /login add keys", () => {
  const merged = mergePrimeCredentials(
    { "openai-codex": oauth("access", "refresh", 1_700_000_000_000), freshly: { type: "api_key", key: "new-key" } },
    { anthropic: { type: "api_key", key: "kept-key" }, "openai-codex": oauth("old-access", "old-refresh", 1_600_000_000_000) },
  );
  assert.deepEqual(merged.anthropic, { type: "api_key", key: "kept-key" });
  assert.deepEqual(merged.freshly, { type: "api_key", key: "new-key" });
  assert.deepEqual(merged["openai-codex"], oauth("access", "refresh", 1_700_000_000_000));
});

test("shared agent files are created once and never rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-credentials-"));
  const agentDir = join(root, ".prime", "agent");
  try {
    assert.equal(await ensurePrimeAgentFiles(agentDir), join(agentDir, "auth.json"));
    for (const name of ["auth.json", ...PRIME_AGENT_PER_RUN_FILES]) {
      assert.equal(await readFile(join(agentDir, name), "utf8"), "{}\n");
      assert.equal((await stat(join(agentDir, name))).mode & 0o777, 0o600);
    }

    await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({ "openai-codex": oauth("access", "refresh", 1) })}\n`);
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark" })}\n`);
    await ensurePrimeAgentFiles(agentDir);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")), { "openai-codex": oauth("access", "refresh", 1) });
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), { theme: "dark" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a signed-in credential file is not recreated when the agent directory already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-credentials-existing-"));
  const agentDir = join(root, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "auth.json"), "{}\n");
    await ensurePrimeAgentFiles(agentDir);
    assert.equal((await stat(agentDir)).isDirectory(), true);
    assert.equal((await stat(join(agentDir, "auth.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const execFileAsync = promisify(execFile);
const bwrapBinary = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((candidate) => existsSync(candidate));

function primeRepositoryForTest(): string | undefined {
  try {
    const repository = resolvePrimeRepository(process.cwd(), join(homedir(), ".prime", "agent"));
    return existsSync(join(repository, "packages", "coding-agent", "dist", "core", "auth-storage.js")) ? repository : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

// Drives Prime's real AuthStorage inside a sandbox: take the same
// proper-lockfile lock Prime uses, read-modify-write auth.json, and replace it
// through a sibling temp file + rename, exactly like the credential writers do.
const refreshHarness = `
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage } from "/opt/prime/packages/coding-agent/dist/core/auth-storage.js";

const [provider, key, holdMs] = process.argv.slice(2);
const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
const authPath = join(agentDir, "auth.json");
const backend = AuthStorage.create(authPath).storage;

await backend.withLockAsync(async (current) => {
  const data = current && current.trim() ? JSON.parse(current) : {};
  data.counter = (data.counter ?? 0) + 1;
  data[provider] = { type: "api_key", key };
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  const temporary = join(agentDir, ".auth.json." + process.pid + ".tmp");
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temporary, authPath);
  return { result: undefined };
});
`;

test("two bwrap sandboxes serialize on one AuthStorage lock and never lose a write", async (t) => {
  const primeRepository = primeRepositoryForTest();
  if (!bwrapBinary) return t.skip("bubblewrap is not installed");
  if (!primeRepository) return t.skip("a Prime Agent checkout with a built coding-agent is not available");
  let primeNodeModules: string;
  try {
    primeNodeModules = realpathSync(join(primeRepository, "node_modules"));
  } catch {
    return t.skip("the Prime Agent checkout has no installed dependencies");
  }

  const root = await mkdtemp(join(tmpdir(), "pi-cad-auth-race-"));
  const durableAgentDir = join(root, "durable-agent");
  const workspace = join(root, "workspace");
  const runDirectories = [join(root, "run-a"), join(root, "run-b")];
  try {
    await ensurePrimeAgentFiles(durableAgentDir);
    await writeFile(join(durableAgentDir, "auth.json"), '{\n  "counter": 0\n}\n', { mode: 0o600 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "refresh.mjs"), refreshHarness);
    for (const directory of runDirectories) await preparePerRunAgentDir(directory);

    const nodeBinary = realpathSync(process.execPath);
    const sandbox = (perRunAgentDir: string, provider: string, holdMs: number) => [
      "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--clearenv",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--dir", "/home", "--dir", "/home/prime", "--dir", "/home/prime/.prime", "--dir", "/opt", "--dir", "/workspace",
      ...["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].filter((path) => existsSync(path)).flatMap((path) => ["--ro-bind", path, path]),
      "--ro-bind", primeRepository, "/opt/prime",
      // Staged runtimes symlink node_modules to an absolute path outside the
      // checkout; bind the target too so the harness can import Prime's real
      // AuthStorage from /opt/prime.
      ...(primeNodeModules === join(primeRepository, "node_modules") ? [] : ["--ro-bind", primeNodeModules, primeNodeModules]),
      "--ro-bind", dirname(nodeBinary), "/opt/node-runtime",
      "--bind", workspace, "/workspace",
      // The production mount layout: a single-file auth.json bind, which makes
      // the rename below fail with EBUSY and the lock per-run, fails this test.
      ...primeAgentMounts(perRunAgentDir, durableAgentDir),
      "--setenv", "HOME", "/home/prime",
      "--setenv", "PATH", "/opt/node-runtime:/usr/bin:/bin",
      "--setenv", "PRIME_AGENT_CODING_AGENT_DIR", "/home/prime/.prime/agent",
      "--chdir", "/workspace",
      "--", join("/opt/node-runtime", basename(nodeBinary)), "/workspace/refresh.mjs", provider, `key-${provider}`, String(holdMs),
    ];

    const first = execFileAsync(bwrapBinary, sandbox(runDirectories[0]!, "alpha", 2_000), { timeout: 60_000 });
    // A lock held inside the sandbox has to show up in the shared directory; a
    // per-run lock directory would mean the two runs never coordinate.
    const lockVisible = await waitFor(() => existsSync(join(durableAgentDir, "auth.json.lock")), 15_000);
    const second = execFileAsync(bwrapBinary, sandbox(runDirectories[1]!, "beta", 0), { timeout: 60_000 });
    try {
      await Promise.all([first, second]);
    } catch (error) {
      const failure = error as Error & { stderr?: string; stdout?: string };
      assert.fail(`sandboxed AuthStorage write failed: ${failure.message}\n${failure.stderr ?? ""}${failure.stdout ?? ""}`);
    }

    assert.equal(lockVisible, true, "the AuthStorage lock must live in the shared agent directory");
    // Both read-modify-writes saw each other: a per-run copy or a per-run lock
    // would leave counter at 1 and drop one of the two credentials.
    const stored = JSON.parse(await readFile(join(durableAgentDir, "auth.json"), "utf8")) as { counter: number } & Record<string, { key?: string }>;
    assert.equal(stored.counter, 2);
    assert.equal(stored.alpha?.key, "key-alpha");
    assert.equal(stored.beta?.key, "key-beta");
    assert.deepEqual(Object.keys(stored).sort(), ["alpha", "beta", "counter"]);
    // The per-launch directories never hold credentials of their own.
    assert.equal(existsSync(join(runDirectories[0]!, "auth.json")), false);
    assert.equal(existsSync(join(runDirectories[1]!, "auth.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
