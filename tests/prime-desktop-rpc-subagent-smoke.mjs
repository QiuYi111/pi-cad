import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const tsx = join(primeRoot, "node_modules/.bin/tsx");
if (!existsSync(tsx)) throw new Error(`Actual Prime dependencies are missing: ${tsx}`);
const fixture = mkdtempSync(join(tmpdir(), "pi-cad-desktop-rpc-subagents-"));
const dataHome = join(fixture, "authority-data");
const projectKey = createHash("sha256").update(realpathSync(fixture)).digest("hex");
const canonicalProject = join(dataHome, "pi-cad", projectKey);
const capture = join(fixture, "subagent-provider-contexts.jsonl");
copyFileSync(join(project, "tests/fixtures/prime-faux-subagents-extension.ts"), join(fixture, "prime-faux-subagents-extension.ts"));

const primeEnv = { ...process.env };
delete primeEnv.HTTP_PROXY;
delete primeEnv.HTTPS_PROXY;
delete primeEnv.ALL_PROXY;
const child = spawn(process.execPath, [
  join(project, "scripts/prime-cad-sidecar.mjs"),
  "--extension", "/workspace/prime-faux-subagents-extension.ts",
  "--daemon-socket", "/workspace/daemon.sock",
  "--provider", "faux",
  "--model", "faux",
  "--mode", "rpc",
], {
  cwd: project,
  env: {
    ...primeEnv,
    PRIME_AGENT_REPO: primeRoot,
    PRIME_SUBAGENT_CAPTURE: "/workspace/subagent-provider-contexts.jsonl",
    PRIME_AGENT_CODING_AGENT_DIR: join(fixture, "prime-agent"),
    PRIME_AGENT_SESSION_DIR: join(fixture, "sessions"),
    PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV ?? resolve(homedir(), ".prime-plan-c/test-kernel-venv"),
    PI_OFFLINE: "0",
    NO_PROXY: "pypi.org,files.pythonhosted.org,registry.npmjs.org",
    PI_CAD_PROJECT_CWD: fixture,
    PI_CAD_REPO: project,
    XDG_DATA_HOME: dataHome,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const findNamedFiles = (directory, name) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return findNamedFiles(path, name);
  return entry.isFile() && entry.name === name ? [path] : [];
});

let buffer = "";
let stderr = "";
const records = [];
const pending = new Map();
let exited = false;
let exitError;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      records.push(record);
      if (record.type === "response" && record.id && pending.has(record.id)) {
        const entry = pending.get(record.id);
        clearTimeout(entry.timer);
        pending.delete(record.id);
        record.success ? entry.resolve(record.data) : entry.reject(new Error(record.error || `${record.command} failed`));
      }
    } catch (error) {
      exitError = new Error(`Prime RPC emitted invalid JSON: ${line}\n${error}`);
    }
  }
});
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
child.once("exit", (code, signal) => {
  exited = true;
  exitError ??= new Error(`Prime RPC exited (${signal || code || 0})\n${stderr}`);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(exitError);
  }
  pending.clear();
});

let sequence = 0;
function request(type, payload = {}, timeoutMs = 60_000) {
  if (exited || !child.stdin.writable) return Promise.reject(exitError ?? new Error("Prime RPC is closed"));
  const id = `res-402-${++sequence}`;
  return new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectResponse(new Error(`Prime RPC ${type} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  });
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let success = false;
try {
  const state = await request("get_state", {}, 60_000);
  assert.ok(state?.sessionId, "Desktop RPC must open a Prime conversation");
  // The host has loaded the fixture if the model call reaches its registered faux provider.
  await request("prompt", { message: "PARENT_SPAWN_TWO: complete both independent CAD child tasks and report their artifacts." });
  const projectStatePath = join(canonicalProject, "v7-project", "state.json");
  // First Desktop RPC startup installs Prime's Python skill dependencies in
  // isolated kernels; allow enough time for parent, children, and grandchild.
  const deadline = Date.now() + 600_000;
  let projectState;
  while (Date.now() < deadline) {
    if (existsSync(projectStatePath)) {
      try { projectState = JSON.parse(readFileSync(projectStatePath, "utf8")); } catch { projectState = undefined; }
    }
    const bindings = Object.values(projectState?.conversations ?? {});
    if (bindings.length === 4 && bindings.every((binding) => existsSync(join(canonicalProject, "runs", binding.runId, "state.json")))) {
      const runs = bindings.map((binding) => JSON.parse(readFileSync(join(canonicalProject, "runs", binding.runId, "state.json"), "utf8")));
      if (runs.every((run) => run.status === "done")) break;
    }
    await delay(200);
  }
  assert.ok(Date.now() < deadline, `Desktop RPC subagent workflow did not finish\n${stderr}`);
  assert.ok(existsSync(join(fixture, "subagent-provider-loaded.txt")), "Prime must load the faux provider fixture before starting the model");
  assert.ok(existsSync(join(fixture, "subagents/child-a/model.step")));
  assert.ok(existsSync(join(fixture, "subagents/child-b/model.step")));
  assert.ok(existsSync(join(fixture, "subagents/grandchild/model.step")));
  let kernelStates = [];
  const kernelDeadline = Date.now() + 30_000;
  while (Date.now() < kernelDeadline) {
    kernelStates = findNamedFiles(join(fixture, "session-artifacts"), "kernel-state.json");
    if (kernelStates.length >= 4) break;
    await delay(100);
  }
  assert.ok(kernelStates.length >= 4, "Desktop RPC parent, two children, and grandchild must each own a separate kernel state");
  assert.equal(new Set(kernelStates).size, kernelStates.length);
  let sessionText = "";
  const messageDeadline = Date.now() + 60_000;
  while (Date.now() < messageDeadline) {
    const messages = await request("get_messages");
    sessionText = JSON.stringify(messages?.messages ?? []);
    if (/CHILD_A_ARTIFACT/.test(sessionText) && /CHILD_B_ARTIFACT/.test(sessionText) && /GRANDCHILD_ARTIFACT/.test(sessionText)) break;
    await delay(250);
  }
  assert.match(sessionText, /CHILD_A_ARTIFACT.*sha256=[a-f0-9]{64}/);
  assert.match(sessionText, /CHILD_B_ARTIFACT.*sha256=[a-f0-9]{64}/);
  assert.match(sessionText, /GRANDCHILD_ARTIFACT.*sha256=[a-f0-9]{64}/);
  const contexts = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const depths = contexts.map((context) => Number(String(context.systemPrompt ?? "").match(/Recursive agent depth:\s*(\d+)/)?.[1] ?? 0));
  assert.ok(depths.includes(2), "Desktop RPC must create and execute the nested grandchild runtime");
  assert.ok(contexts.filter((context) => Number(String(context.systemPrompt ?? "").match(/Recursive agent depth:\s*(\d+)/)?.[1] ?? 0) > 0)
    .some((context) => context.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).some((item) => item.type === "image")),
  "Desktop RPC CAD previews must reach Prime through the typed image channel");
  const verified = spawnSync(tsx, [join(project, "tests/verify-prime-subagent-smoke.ts"), fixture], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PI_CAD_REPO: project, XDG_DATA_HOME: dataHome, PI_CAD_CANONICAL_PROJECT_DIR: canonicalProject },
  });
  assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
  success = true;
  console.log("Desktop RPC created isolated parent, child, and grandchild CAD runs; recovered after a child provider failure and adopted all child artifacts.");
} finally {
  if (!exited) {
    child.stdin.end();
    await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(15_000)]);
    if (!exited) child.kill("SIGTERM");
  }
  if (success && process.env.RES406_KEEP_SMOKE !== "1") rmSync(fixture, { recursive: true, force: true });
  else console.error(`Desktop RPC smoke artifacts kept at ${fixture}`);
}
