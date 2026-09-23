import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const tsx = join(primeRoot, "node_modules/.bin/tsx");
if (!existsSync(tsx)) throw new Error(`Actual Prime dependencies are missing: ${tsx}`);
const fixture = mkdtempSync(join(tmpdir(), "pi-cad-prime-subagents-"));
let verifiedSmoke = false;
const readJsonlTree = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return readJsonlTree(path);
  return entry.isFile() && entry.name.endsWith(".jsonl") ? [readFileSync(path, "utf8")] : [];
});
const findNamedFiles = (directory, name) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return findNamedFiles(path, name);
  return entry.isFile() && entry.name === name ? [path] : [];
});
try {
  const dataHome = join(fixture, "authority-data");
  const projectKey = createHash("sha256").update(realpathSync(fixture)).digest("hex");
  const canonicalProject = join(dataHome, "pi-cad", projectKey);
  const capture = join(fixture, "subagent-provider-contexts.jsonl");
  copyFileSync(join(project, "tests/fixtures/prime-faux-subagents-extension.ts"), join(fixture, "prime-faux-subagents-extension.ts"));

  const primeEnv = { ...process.env };
  delete primeEnv.HTTP_PROXY;
  delete primeEnv.HTTPS_PROXY;
  delete primeEnv.ALL_PROXY;
  const run = spawnSync(process.execPath, [
    join(project, "scripts/prime-cad-sidecar.mjs"),
    "--extension", "/workspace/prime-faux-subagents-extension.ts",
    "--daemon-socket", "/workspace/daemon.sock",
    "--provider", "faux",
    "--model", "faux",
    "--mode", "json",
    "--print", "PARENT_SPAWN_TWO: complete both independent CAD child tasks and report their artifacts.",
  ], {
    cwd: project,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...primeEnv,
      PRIME_AGENT_REPO: primeRoot,
      PRIME_SUBAGENT_CAPTURE: capture,
      PRIME_AGENT_CODING_AGENT_DIR: join(fixture, "prime-agent"),
      PRIME_AGENT_SESSION_DIR: join(fixture, "sessions"),
      PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV ?? resolve(homedir(), ".prime-plan-c/test-kernel-venv"),
      PI_OFFLINE: "0",
      NO_PROXY: "pypi.org,files.pythonhosted.org,registry.npmjs.org",
      PI_CAD_PROJECT_CWD: fixture,
      PI_CAD_REPO: project,
      XDG_DATA_HOME: dataHome,
    },
  });
  const diagnostic = `${run.stderr}\n${run.stdout}`;
  assert.notEqual(run.signal, "SIGTERM", `Prime subagent smoke timed out\n${diagnostic.slice(-12000)}`);
  assert.equal(run.status, 0, `Prime subagent smoke failed\n${diagnostic.slice(-16000)}`);
  const allSessionLogs = readJsonlTree(join(fixture, "session-artifacts")).join("\n");
  const rootSessionLogs = readJsonlTree(join(fixture, ".prime-sessions")).join("\n");
  assert.match(allSessionLogs, /CHILD_A_ARTIFACT[^\n]*sha256=[a-f0-9]{64}[^\n]*x.: 25/);
  assert.match(allSessionLogs, /CHILD_B_ARTIFACT[^\n]*sha256=[a-f0-9]{64}[^\n]*volume.: 512/);
  assert.match(allSessionLogs, /GRANDCHILD_ARTIFACT[^\n]*sha256=[a-f0-9]{64}[^\n]*volume.: 125/);
  assert.match(rootSessionLogs, /CHILD_A_ARTIFACT[^\n]*sha256=[a-f0-9]{64}/, "parent must receive child A's ArtifactRef message");
  assert.match(rootSessionLogs, /CHILD_B_ARTIFACT[^\n]*sha256=[a-f0-9]{64}/, "parent must receive child B's ArtifactRef message");
  assert.match(rootSessionLogs, /GRANDCHILD_ARTIFACT[^\n]*sha256=[a-f0-9]{64}/, "parent must receive the grandchild ArtifactRef relayed by child A");
  assert.match(rootSessionLogs, /RLM child cad-fault-child[^\n]*completed without sending a reply/, "a child provider failure must stay local while the parent continues");
  assert.ok(existsSync(join(fixture, "subagents/child-a/model.step")), "child A must write its own STEP output");
  assert.ok(existsSync(join(fixture, "subagents/child-b/model.step")), "child B must write a separate STEP output");
  assert.ok(existsSync(join(fixture, "subagents/grandchild/model.step")), "grandchild must write a separate STEP output");
  const kernelStates = findNamedFiles(join(fixture, "session-artifacts"), "kernel-state.json");
  assert.ok(kernelStates.length >= 4, "parent, two children, and grandchild must each own a separate kernel state");
  assert.equal(new Set(kernelStates).size, kernelStates.length);
  assert.ok(existsSync(capture), "the faux provider must record Prime calls");

  const contexts = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const depths = contexts.map((context) => Number(String(context.systemPrompt ?? "").match(/Recursive agent depth:\s*(\d+)/)?.[1] ?? 0));
  assert.ok(depths.includes(0), "the parent must call the real Prime provider");
  assert.ok(depths.includes(1), "inline RLM children must call the real Prime provider independently");
  assert.ok(depths.includes(2), "the inline grandchild must call the real Prime provider independently");
  const childContexts = contexts.filter((context) => Number(String(context.systemPrompt ?? "").match(/Recursive agent depth:\s*(\d+)/)?.[1] ?? 0) > 0);
  assert.ok(childContexts.some((context) => context.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).some((item) => item.type === "image")), "CAD build preview must use Prime's typed image channel");

  const verified = spawnSync(tsx, [join(project, "tests/verify-prime-subagent-smoke.ts"), fixture], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PI_CAD_REPO: project, XDG_DATA_HOME: dataHome, PI_CAD_CANONICAL_PROJECT_DIR: canonicalProject },
  });
  assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
  verifiedSmoke = true;
  console.log("Prime inline subagents independently built, probed, repaired, and returned their CAD artifacts.");
} finally {
  if (verifiedSmoke) rmSync(fixture, { recursive: true, force: true });
  else console.error(`Prime smoke artifacts kept at ${fixture}`);
}
