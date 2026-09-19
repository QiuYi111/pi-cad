import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WorkerCore } from "../packages/reify-cad-worker/src/session.mjs";
import { toolCatalog } from "../packages/reify-cad-worker/src/server.mjs";
import { adaptRequest, conversionErrorResponse } from "../packages/reify-cad-worker/src/path-transport.mjs";
import { runtimePaths } from "../packages/reify-cad-worker/src/runtime.mjs";
import { fakeLauncherFactory } from "./reify-cad-worker-fixtures/fake-prime.mjs";

const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
const originalPiCadRepo = process.env.REIFY_PI_CAD_REPO;
const originalPrimeAgentRepo = process.env.PRIME_AGENT_REPO;
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
  await mkdir(join(cwd, "build"));
  await writeFile(join(cwd, "build", "part.step"), "STEP");
  await writeFile(join(cwd, "build", "part.py"), "print('cad')");
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
  assert.equal(before.progress_signal, "idle");
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

await test("Prime needs_input overrides streaming and reports a user decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-input-"));
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher, agentApi: async () => null });
  const started = await core.start({ cwd });
  fake.primes[0].state = "streaming";
  fake.primes[0].emit("event", { type: "agent_status", status: { taskState: "needs_input" } });
  const status = await core.status({ session_id: started.session_id });
  assert.equal(status.status, "waiting_user");
  assert.equal(status.outcome, "USER_DECISION_REQUIRED");
  assert.equal(status.blocker?.type, "USER_DECISION_REQUIRED");
  assert.ok((await core.events({ session_id: started.session_id })).events.some((event) => event.type === "user_input_required"));
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("assistant model errors are counted and surfaced as a blocker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-model-error-"));
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher, agentApi: async () => null });
  const started = await core.start({ cwd });
  for (let index = 0; index < 3; index++) fake.primes[0].emit("event", {
    type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed" },
  });
  const status = await core.status({ session_id: started.session_id });
  assert.equal(status.metrics.model_errors, 3);
  assert.equal(status.progress_signal, "model_failure");
  assert.match(status.blocker.message, /fetch failed/);
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("accepted and idle unfinished tasks are not reported as completed progress", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-stall-"));
  let clock = 1_000_000;
  const fake = fakeLauncherFactory({ startDelayMs: 25 });
  const core = new WorkerCore({ launcher: fake.launcher, now: () => clock, agentApi: async () => null });
  const started = await core.start({ cwd });
  const sent = await core.send({ session_id: started.session_id, prompt: "Build a bracket" });
  assert.equal(sent.status, "starting");
  await sleep(8);
  clock += 91_000;
  const stalled = await core.status({ session_id: started.session_id });
  assert.equal(stalled.progress_signal, "stalled");
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("active workflow stops reporting progress after an idle turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-active-idle-"));
  await mkdir(join(cwd, ".pi-cad"));
  await writeFile(join(cwd, ".pi-cad", "status.json"), JSON.stringify({ run: { workflowId: "mechanical.quick-build", phase: "build", status: "active" } }));
  let clock = 1_000_000;
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher, now: () => clock, agentApi: async () => null });
  const started = await core.start({ cwd });
  await core.send({ session_id: started.session_id, prompt: "Build a bracket" });
  await sleep(8);
  clock += 91_000;
  const status = await core.status({ session_id: started.session_id });
  assert.equal(status.status, "ready");
  assert.equal(status.progress_signal, "stalled");
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("artifacts finds managed subdirectories and ignores unrelated project files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-artifacts-"));
  await writeFile(join(cwd, "tmp_stl_bounds.py"), "print('unrelated')");
  const nested = join(cwd, "session-artifacts", "task-1");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "real.step"), "STEP");
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher, agentApi: async () => null });
  const started = await core.start({ cwd });
  const artifacts = await core.artifacts({ session_id: started.session_id });
  assert.deepEqual(artifacts.artifacts.map((item) => item.project_path), ["session-artifacts/task-1/real.step"]);
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("artifacts includes authoritative Pi-CAD catalog entries at project root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cad-worker-catalog-"));
  await writeFile(join(cwd, "approved.step"), "STEP");
  await writeFile(join(cwd, "tmp_stl_bounds.py"), "print('unrelated')");
  const fake = fakeLauncherFactory();
  const core = new WorkerCore({ launcher: fake.launcher, agentApi: async () => ({ projectHead: { artifacts: [{ path: "approved.step", role: "candidate:authoritative", sha256: "abc" }] } }) });
  const started = await core.start({ cwd });
  const artifacts = await core.artifacts({ session_id: started.session_id });
  assert.deepEqual(artifacts.artifacts.map((item) => item.project_path), ["approved.step"]);
  await core.close({ session_id: started.session_id });
  await rm(cwd, { recursive: true, force: true });
});

await test("Windows mapped-drive conversion fails clearly and UNC paths use Windows separators", async () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "cad_worker.start", arguments: { cwd: "V:\\home\\jingyi\\project" } } });
  await assert.rejects(() => adaptRequest("Ubuntu", line, async () => { throw new Error("wslpath cannot resolve V:"); }), (error) => {
    assert.match(error.message, /cannot convert.*WSL/i);
    assert.deepEqual(conversionErrorResponse(error), { jsonrpc: "2.0", id: 17, error: { code: -32602, message: error.message } });
    return true;
  });
  assert.equal(runtimePaths("/tmp/cad-result.step", "windows", "Ubuntu").windowsPath, "\\\\wsl.localhost\\Ubuntu\\tmp\\cad-result.step");
});
process.env.REIFY_PI_CAD_REPO = originalPiCadRepo;
if (originalPrimeAgentRepo === undefined) delete process.env.PRIME_AGENT_REPO;
else process.env.PRIME_AGENT_REPO = originalPrimeAgentRepo;
if (originalPiCadRepo === undefined) delete process.env.REIFY_PI_CAD_REPO;
