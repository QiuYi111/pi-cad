import assert from "node:assert/strict";
import { test } from "node:test";

import { Session, PROXY_NAME } from "../chaos/sut/session.ts";
import { isProcessAlive } from "../chaos/sut/proc.ts";
import { Trace, InvariantViolation } from "../chaos/types.ts";
import { checkInvariants } from "../chaos/invariants/index.ts";
import { executeCommand, runSequence, settleWindowFor } from "../chaos/runner/runner.ts";
import type { Command } from "../chaos/model/commands.ts";
import type { BugName } from "../chaos/sut/server.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A short, deterministic fault chain: start a run, kill its worker, recover, continue. */
const faultChain: Command[] = [
  { kind: "action", name: "createProject", params: {} },
  { kind: "action", name: "createRun", params: { projectIndex: 0 } },
  { kind: "action", name: "startWorker", params: { runIndex: 0 } },
  { kind: "action", name: "settle", params: { ms: 300 } },
  { kind: "fault", name: "killWorker", params: { runIndex: 0 } },
  { kind: "action", name: "settle", params: { ms: 400 } },
  { kind: "action", name: "continueRun", params: { runIndex: 0 } },
  { kind: "action", name: "settle", params: { ms: 300 } },
];

async function withSession<T>(bug: BugName | null, body: (session: Session) => Promise<T>): Promise<T> {
  const session = await Session.start({ bug });
  try {
    await session.reset();
    return await body(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

test("chaos: 真实 kill worker 后系统自己恢复，invariant 全部成立", async () => {
  await withSession(null, async (session) => {
    const trace = new Trace();
    await runSequence(session, faultChain, trace, 800);
    const snapshot = await session.snapshot();
    assert.equal(snapshot.runs.length, 1);
    assert.ok(
      (snapshot.runs[0].crashedWorkers ?? 0) >= 1,
      "killWorker 必须真的杀掉一个 worker 进程",
    );
    assert.ok(["RUNNING", "COMPLETED"].includes(snapshot.runs[0].state));
  });
});

test("chaos: 注入的恢复 bug 会被 invariant 抓到", async () => {
  let violation: InvariantViolation | null = null;
  await withSession("double-worker", async (session) => {
    const trace = new Trace();
    try {
      await runSequence(session, faultChain, trace, 800);
    } catch (error) {
      if (error instanceof InvariantViolation) violation = error;
      else throw error;
    }
  });
  assert.ok(violation, "double-worker bug 必须被 invariant 抓到");
  assert.ok(
    ["worker-ownership", "worker-liveness", "single-active-worker"].includes(violation!.invariant),
    `unexpected invariant ${violation!.invariant}`,
  );
});

test("chaos: pause / resume 是真的进程信号", async () => {
  await withSession(null, async (session) => {
    const trace = new Trace();
    await executeCommand(session, { kind: "action", name: "createRun", params: { projectIndex: 0 } }, trace);
    await executeCommand(session, { kind: "action", name: "startWorker", params: { runIndex: 0 } }, trace);
    await sleep(500);
    const before = await session.snapshot();
    const worker = before.workers.find((candidate) => candidate.status === "running");
    assert.ok(worker, "worker 必须已经起来");
    assert.ok(isProcessAlive(worker!.pid));

    await executeCommand(session, { kind: "fault", name: "pauseWorker", params: { runIndex: 0 } }, trace);
    await sleep(settleWindowFor({ kind: "fault", name: "pauseWorker", params: {} }));
    // SIGSTOP 只暂停进程，进程仍在。
    assert.ok(isProcessAlive(worker!.pid), "暂停后进程仍在");
    const paused = await session.snapshot();
    await checkInvariants({ session, snapshot: paused, now: Date.now() });

    await session.faults.recoverAll(trace);
    await sleep(200);
    const resumed = await session.snapshot();
    await checkInvariants({ session, snapshot: resumed, now: Date.now() });
  });
});

test("chaos: 外部 API 故障走真实 Toxiproxy", async (t) => {
  await withSession(null, async (session) => {
    if (!session.hasExternalFaults) {
      t.skip("toxiproxy 未安装，跳过外部故障用例（npm run chaos:fetch-tools）");
      return;
    }
    const trace = new Trace();
    await executeCommand(session, { kind: "fault", name: "externalLatency", params: { latencyMs: 800 } }, trace);
    const toxics = await session.toxiproxyClient!.listToxics(PROXY_NAME);
    assert.ok(
      toxics.some((toxic) => toxic.type === "latency"),
      "latency toxic 必须注册到 Toxiproxy 代理上",
    );
    await session.faults.recoverAll(trace);
    const after = await session.toxiproxyClient!.listToxics(PROXY_NAME);
    assert.equal(after.length, 0);
  });
});
