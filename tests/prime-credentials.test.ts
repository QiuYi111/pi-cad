import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildPrimeBwrapArgs,
  buildReviewerBwrapArgs,
  ensurePrimeCredentialFile,
  mergePrimeCredentials,
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

test("Prime and reviewer sandboxes share the one durable credential file", () => {
  const author = buildPrimeBwrapArgs(paths, ["--print", "build it"]).join("\n");
  assert.match(author, /--bind\n\/run\/private\/prime-agent\n\/home\/prime\/\.prime\/agent/);
  assert.match(author, /--bind\n\/host\/agent\/auth\.json\n\/home\/prime\/\.prime\/agent\/auth\.json/);
  // Only the credential file is shared; the rest of the durable agent directory
  // (settings, sessions, telemetry) stays per launch.
  assert.doesNotMatch(author, /--bind\n\/host\/agent\n/);
  assert.doesNotMatch(author, /--ro-bind\n\/host\/agent\n/);

  const reviewer = buildReviewerBwrapArgs(paths, {
    reviewId: "review-123",
    reviewerAgentDir: "/run/private/reviewer-agent",
    reviewerWorkspace: "/run/private/reviewer-workspace",
    reviewerSocketDirectory: "/run/private/reviewer",
    prompt: "review exactly one commit",
  }).join("\n");
  assert.match(reviewer, /--bind\n\/run\/private\/reviewer-agent\n\/home\/prime\/\.prime\/agent/);
  assert.match(reviewer, /--bind\n\/host\/agent\/auth\.json\n\/home\/prime\/\.prime\/agent\/auth\.json/);
  assert.doesNotMatch(reviewer, /--bind\n\/host\/agent\n/);
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

test("credential bootstrap creates an empty file once and never rewrites it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-credentials-"));
  const agentDir = join(root, ".prime", "agent");
  try {
    assert.equal(await ensurePrimeCredentialFile(agentDir), join(agentDir, "auth.json"));
    assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), "{}\n");
    assert.equal((await stat(join(agentDir, "auth.json"))).mode & 0o777, 0o600);

    await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({ "openai-codex": oauth("access", "refresh", 1) })}\n`);
    await ensurePrimeCredentialFile(agentDir);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")), { "openai-codex": oauth("access", "refresh", 1) });
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
    await ensurePrimeCredentialFile(agentDir);
    assert.equal((await stat(agentDir)).isDirectory(), true);
    assert.equal((await stat(join(agentDir, "auth.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
