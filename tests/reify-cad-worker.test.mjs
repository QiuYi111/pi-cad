import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WorkerCore } from "../packages/reify-cad-worker/src/session.mjs";
import { toolCatalog } from "../packages/reify-cad-worker/src/server.mjs";
import { fakeLauncherFactory } from "./reify-cad-worker-fixtures/fake-prime.mjs";

const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
const runtime = await mkdtemp(join(tmpdir(), "cad-worker-runtime-"));
const fakePrimeRepo = join(runtime, "prime-agent");
await mkdir(fakePrimeRepo, { recursive: true });
await writeFile(join(fakePrimeRepo, "prime-agent.sh"), "#!/bin/sh\n");
await chmod(join(fakePrimeRepo, "prime-agent.sh"), 0o755);
process.env.REIFY_PI_CAD_REPO = process.cwd();
process.env.PRIME_AGENT_REPO = fakePrimeRepo;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}\n${error?.stack || error}`); process.exitCode = 1; }
};

await test("lifecycle reuses one session and cleans up stale ids", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-"));
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher, idFactory: () => "session-1", agentApi: async () => null });
  const started = await core.start({ cwd });
  assert.equal(started.session_id, "session-1");
  assert.equal(started.paths.displayPath, started.cwd);
  assert.equal(started.model.provider, "openai-codex");
  const first = await core.send({ session_id: "session-1", prompt: "Design a hinge" });
  assert.equal(first.status, "running");
  await sleep(8);
  const status = await core.status({ session_id: "session-1" });
  assert.equal(status.status, "ready");
  assert.ok(status.metrics.agent_turns >= 1);
  const second = await core.send({ session_id: "session-1", prompt: "Increase pin clearance to 0.2 mm" });
  assert.equal(second.session_id, "session-1");
  await sleep(8);
  const artifacts = await core.artifacts({ session_id: "session-1" });
  assert.equal(artifacts.artifacts.length, 0);
  const running = await core.send({ session_id: "session-1", prompt: "Cancel this" });
  assert.equal(running.status, "running");
  const canceled = await core.cancel({ session_id: "session-1" });
  assert.equal(canceled.status, "canceled");
  const closed = await core.close({ session_id: "session-1" });
  assert.equal(closed.closed, true);
  assert.equal(fake.primes[0].stopped, true);
  assert.equal(fake.primes[0].getMessagesCount, 0);
  await assert.rejects(() => core.status({ session_id: "session-1" }), /unknown or closed/);
  await rm(cwd, { recursive: true, force: true });
});

await test("returns a compact boundary and exposes canonical blocker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-blocker-"));
  const fake = fakeLauncherFactory();
  await mkdir(join(cwd, ".pi-cad"), { recursive: true });
  await writeFile(join(cwd, ".pi-cad", "status.json"), JSON.stringify({ run: { workflowId: "mechanical.design", phase: "requirements", status: "waiting_user", warnings: ["wait_for_user: choose aluminum or ABS"] } }));
  await writeFile(join(cwd, "part.step"), "STEP");
  await writeFile(join(cwd, "part.py"), "print('cad')");
  const core = new WorkerCore({ launcher: fake.launcher, idFactory: () => "session-blocked" });
  const started = await core.start({ cwd, callerHost: "windows" });
  const status = await core.status({ session_id: started.session_id });
  assert.equal(status.status, "waiting_user");
  assert.equal(status.outcome, "USER_DECISION_REQUIRED");
  assert.ok(status.blocker, JSON.stringify(status));
  assert.equal(status.blocker.type, "USER_DECISION_REQUIRED");
  assert.match(status.blocker.message, /aluminum or ABS/);
  assert.equal(status.metrics.transcript_bytes_returned, 0);
  const answer = await core.send({ session_id: started.session_id, prompt: "Use 6061 aluminum." });
  assert.equal(answer.session_id, started.session_id);
  const artifacts = await core.artifacts({ session_id: started.session_id });
  assert.deepEqual(artifacts.artifacts.map((item) => item.kind).sort(), ["source", "step"]);
  assert.match(artifacts.artifacts[0].paths.windowsPath, /wsl\.localhost/);
  assert.equal(status.metrics.transcript_bytes_returned, 0);
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("events identify repeated failure and steering keeps the session", async () => {
  let strategyChanged = false;
  const fake = fakeLauncherFactory({
    failures: 3,
    promptDelayMs: 15,
    failingCode: "cad.probe.run(); subtract same body",
    onSteer: () => { strategyChanged = true; },
  });
  const core = new WorkerCore({ launcher: fake.launcher, idFactory: () => "session-supervised", agentApi: async () => null });
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-steer-"));
  const started = await core.start({ cwd });
  await core.send({ session_id: started.session_id, prompt: "Design a bracket" });
  fake.primes[0].state = "streaming";
  await assert.rejects(() => core.send({ session_id: started.session_id, prompt: "new prompt while busy" }), /busy/);
  await sleep(20);
  const events = await core.events({ session_id: started.session_id });
  assert.ok(events.events.some((event) => event.type === "action_failed" && event.failure_streak === 3));
  const before = await core.status({ session_id: started.session_id });
  assert.equal(before.progress_signal, "progressing");
  fake.primes[0].state = "streaming";
  await core.steer({ session_id: started.session_id, instruction: "Stop repeating the Boolean. Re-evaluate construction." });
  assert.equal(strategyChanged, true);
  assert.equal(fake.primes[0].steerCount, 1);
  assert.equal(fake.primes[0].sessionId, "prime-session-supervised");
  fake.primes[0].state = "ready";
  await sleep(1);
  const after = await core.status({ session_id: started.session_id });
  assert.equal(after.status, "ready");
  await core.interrupt({ session_id: started.session_id });
  assert.equal(fake.primes[0].abortCount, 1);
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("MCP stdio exposes one stable catalog and maps tool calls", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/reify-cad-worker/mcp.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => messages.push(JSON.parse(line)));
  const request = (id, method, params) => new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 3000);
    const seen = () => {
      const found = messages.find((message) => message.id === id);
      if (found) { clearTimeout(timer); rl.off("line", seen); accept(found); }
    };
    rl.on("line", seen);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...params })}\n`);
  });
  const init = await request(1, "initialize", {});
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const catalog = await request(2, "tools/list", {});
  assert.equal(catalog.result.tools.length, 10);
  assert.ok(toolCatalog().tools.every((item) => item.name.startsWith("cad_worker.")));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const bad = await request(4, "tools/call", { params: { name: "cad_worker.status", arguments: { session_id: "missing" } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /invalid_session/);
  child.stdin.end();
  await new Promise((accept) => child.once("exit", accept));
});

await test("invalid project and empty prompt fail clearly", async () => {
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher });
  await assert.rejects(() => core.start({ cwd: "C:\\project" }), /Linux\/WSL path/);
  await assert.rejects(() => core.start({ cwd: "/definitely/missing" }), /does not exist/);
});
