import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const fixture = mkdtempSync(join(tmpdir(), "pi-cad-daemon-cancel-restart-"));
const dataHome = join(fixture, "authority-data");
const projectKey = createHash("sha256").update(resolve(fixture)).digest("hex");
const canonicalProject = join(dataHome, "pi-cad", projectKey);
const socketPath = join(fixture, "daemon.sock");
const extensionPath = join(fixture, "prime-faux-subagents-extension.ts");
const capturePath = join(fixture, "daemon-provider-contexts.jsonl");
copyFileSync(join(project, "tests/fixtures/prime-faux-subagents-extension.ts"), extensionPath);

const env = { ...process.env };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
Object.assign(env, {
  PRIME_AGENT_REPO: primeRoot,
  PRIME_AGENT_CODING_AGENT_DIR: join(fixture, "agent"),
  PRIME_AGENT_SESSION_DIR: join(fixture, "agent", "sessions"),
  PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV ?? resolve(homedir(), ".prime-plan-c/test-kernel-venv"),
  PRIME_SUBAGENT_CAPTURE: capturePath,
  PI_CAD_REPO: project,
  PI_CAD_PROJECT_CWD: fixture,
  XDG_DATA_HOME: dataHome,
  PI_OFFLINE: "0",
  NO_PROXY: "pypi.org,files.pythonhosted.org,registry.npmjs.org",
});

const child = spawn(process.execPath, [
  join(project, "scripts/prime-cad-sidecar.mjs"),
  "--mode", "daemon",
  "--daemon-socket", "/workspace/daemon.sock",
  "--extension", "/workspace/prime-faux-subagents-extension.ts",
  "--provider", "faux",
  "--model", "faux",
], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-16000); });
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-24000); });

let socket;
let socketBuffer = "";
let clientId = `res406-${process.pid}`;
let sequence = 0;
const pending = new Map();
const messages = [];
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));

function attachSocket(candidate) {
  socket = candidate;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    socketBuffer += chunk;
    while (true) {
      const newline = socketBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = socketBuffer.slice(0, newline).replace(/\r$/, "");
      socketBuffer = socketBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "response" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });
  socket.on("error", (error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  });
}

async function connectEventually(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Prime daemon exited (${child.exitCode})\n${stderr}\n${stdout}`);
    try {
      const candidate = createConnection(socketPath);
      await new Promise((accept, reject) => {
        candidate.once("connect", accept);
        candidate.once("error", reject);
      });
      attachSocket(candidate);
      const helloDeadline = Date.now() + 5000;
      while (!messages.some((message) => message.type === "daemon_hello") && Date.now() < helloDeadline) await delay(20);
      const hello = messages.find((message) => message.type === "daemon_hello");
      assert.ok(hello, "Prime daemon must send its protocol hello");
      assert.equal(hello.runtime.buildId, "dfaee806", "smoke must use the recorded Prime main build");
      assert.ok(hello.serverCapabilities.includes("authoritative_child_roster"));
      return hello;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`Timed out connecting to Prime daemon: ${lastError}\n${stderr}\n${stdout}`);
}

function request(command, timeoutMs = 60_000) {
  const id = `res406-${++sequence}`;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Prime daemon ${command.type} timed out after ${timeoutMs}ms\n${stderr}\n${stdout}`));
    }, timeoutMs);
    pending.set(id, { resolve: accept, reject, timer });
    socket.write(`${JSON.stringify({
      type: "command",
      id,
      protocol: { name: "prime-agent.daemon", version: 7 },
      clientId,
      command,
    })}\n`);
  });
}

async function waitForFile(path, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    if (child.exitCode !== null) throw new Error(`Prime daemon exited before ${path}\n${stderr}\n${stdout}`);
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}\n${stderr}\n${stdout}`);
}

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}\n${stderr}\n${stdout}`);
}

function pidInNamespaceAlive(identity) {
  return readdirSync("/proc", { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return false;
    try {
      if (readlinkSync(`/proc/${entry.name}/ns/pid`) !== identity.pidNamespace) return false;
      const status = readFileSync(`/proc/${entry.name}/status`, "utf8");
      const namespaces = status.match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/).map(Number);
      return namespaces?.at(-1) === identity.pid;
    } catch {
      return false;
    }
  });
}

async function stopDaemon() {
  if (socket?.writable && child.exitCode === null) {
    await Promise.race([
      request({ type: "shutdown", force: true }, 3000).catch(() => undefined),
      delay(3500),
    ]);
  }
  socket?.destroy();
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((accept) => child.once("exit", accept)), delay(8000)]);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    if (child.exitCode === null) await Promise.race([new Promise((accept) => child.once("exit", accept)), delay(3000)]);
  }
}

let success = false;
try {
  await connectEventually();
  const created = await request({
    type: "create",
    config: {
      cwd: "/workspace",
      agentDir: "/workspace/agent",
      sessionDir: "/workspace/agent/sessions",
      provider: "faux",
      model: "faux",
      apiKey: "faux-key",
      extensions: ["/workspace/prime-faux-subagents-extension.ts"],
      noContextFiles: true,
      noSkills: true,
      noTools: false,
    },
  });
  assert.equal(created.success, true, created.error);
  const activeSessionId = created.data.activeSessionId ?? created.data.id;
  assert.equal(created.data.model.provider, "faux");

  const prompted = await request({ type: "prompt", activeSessionId, message: "DAEMON_CANCEL_RESTART: start two CAD children, cancel one, preserve the sibling kernel, then restart the cancelled work." });
  assert.equal(prompted.success, true, prompted.error);
  const childIds = await waitForFile(join(fixture, "daemon-child-ids.json"));
  await waitForFile(join(fixture, "daemon-target-kernel-started"));
  const siblingKernel = await waitForFile(join(fixture, "daemon-sibling-kernel.json"));

  const roster = await request({ type: "get_rlm_children", activeSessionId });
  assert.equal(roster.success, true, roster.error);
  const children = roster.data?.children ?? roster.data?.agents ?? roster.data?.subagents ?? [];
  const target = children.find((item) => (item.rlmChildId ?? item.rlm_child_id ?? item.id) === childIds.target);
  const sibling = children.find((item) => (item.rlmChildId ?? item.rlm_child_id ?? item.id) === childIds.sibling);
  assert.ok(target, `target must be present in live daemon child roster: ${JSON.stringify(roster.data)}`);
  assert.ok(sibling, `sibling must be present in live daemon child roster: ${JSON.stringify(roster.data)}`);
  assert.equal(sibling.status, "running", "sibling's live RLM run must be visible before cancellation");

  const cancelled = await request({ type: "cancel_rlm_child", activeSessionId, childId: childIds.target });
  assert.equal(cancelled.success, true, cancelled.error);
  assert.equal(cancelled.data?.cancelled, true, `Prime must confirm cancellation: ${JSON.stringify(cancelled.data)}`);
  const siblingAfterCancel = await waitFor(async () => {
    const current = await request({ type: "get_rlm_children", activeSessionId });
    const currentChildren = current.data?.children ?? current.data?.agents ?? current.data?.subagents ?? [];
    const liveSibling = currentChildren.find((item) => (item.rlmChildId ?? item.rlm_child_id ?? item.id) === childIds.sibling);
    const cancelledTarget = currentChildren.some((item) => (item.rlmChildId ?? item.rlm_child_id ?? item.id) === childIds.target);
    return liveSibling?.status === "running" && !cancelledTarget ? liveSibling : undefined;
  }, "target removal with sibling still running");
  assert.ok(pidInNamespaceAlive(siblingKernel), `sibling CAD kernel ${JSON.stringify(siblingKernel)} must remain alive after target cancellation`);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(fixture, "daemon-release-sibling"), "released\n", "utf8"));
  const siblingResult = await waitForFile(join(fixture, "daemon-sibling-done.json"));
  assert.match(siblingResult.sha256, /^[a-f0-9]{64}$/);
  assert.equal(siblingResult.volume, 512);

  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(fixture, "daemon-restart-target"), "restart\n", "utf8"));
  const restartArtifact = await waitForFile(join(fixture, "daemon-restart-artifact.json"));
  assert.match(restartArtifact.sha256, /^[a-f0-9]{64}$/);
  const completed = await waitForFile(join(fixture, "daemon-parent-complete.json"));
  assert.equal(completed.target, childIds.target);
  assert.equal(completed.sibling, childIds.sibling);
  assert.notEqual(completed.restart, completed.target, "restart must create an independent RLM child run");
  assert.equal(completed.statuses[completed.sibling], "completed");
  assert.equal(completed.statuses[completed.restart], "completed");
  assert.ok(existsSync(join(fixture, "subagents/daemon-sibling/model.step")));
  assert.ok(existsSync(join(fixture, "subagents/daemon-restarted-target/model.step")), "restarted child must build its own CAD artifact");

  const projectStatePath = join(canonicalProject, "v7-project", "state.json");
  const state = JSON.parse(readFileSync(projectStatePath, "utf8"));
  const bindings = Object.values(state.conversations ?? {});
  assert.ok(bindings.length >= 3, `parent, sibling, and restarted child need separate CAD run bindings: ${bindings.length}`);
  assert.ok(new Set(bindings.map((binding) => binding.runId)).size === bindings.length, "daemon child canonical CAD runs must be unique");
  success = true;
  console.log(JSON.stringify({
    result: "PASS",
    primeBuild: "dfaee8067c5def339d1ca0d7b9f3573bc86c948c",
    piCadHead: process.env.PI_CAD_GIT_SHA ?? "workspace",
    activeSessionId,
    cancelledChildId: childIds.target,
    siblingChildId: childIds.sibling,
    siblingKernelPid: siblingKernel.pid,
    siblingKernelSurvivedCancellation: true,
    siblingArtifact: siblingResult,
    restartedChildId: completed.restart,
    childStatuses: completed.statuses,
    canonicalRunIds: bindings.map((binding) => binding.runId),
  }, null, 2));
} catch (error) {
  console.error(error?.stack ?? error);
  throw error;
} finally {
  await stopDaemon();
  if (success) rmSync(fixture, { recursive: true, force: true });
  else console.error(`Daemon smoke artifacts retained at ${fixture}\n${stderr}\n${stdout}`);
}
