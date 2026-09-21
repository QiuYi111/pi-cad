import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import fc from "fast-check";

import { InvariantViolation } from "../chaos/types.ts";
import { reifyActionDefinitions } from "../chaos/reify/actions.ts";
import { reifyFaultDefinitions } from "../chaos/reify/faults.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP, buildReifySequenceArbitrary } from "../chaos/reify/model.ts";
import { recoverInjectedFaults, runReifySequence } from "../chaos/reify/runner.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";
import type { ReifyFaultDefinition } from "../chaos/reify/types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRealSession<T>(body: (session: ReifySession, trace: ReifyTrace) => Promise<T>): Promise<T> {
  const session = await ReifySession.start();
  const trace = new ReifyTrace();
  try {
    return await body(session, trace);
  } finally {
    await session.close().catch(() => undefined);
  }
}

test("reify chaos: 真 kernel 被杀后系统自己恢复，invariant 全过", async () => {
  await withRealSession(async (session, trace) => {
    const chain: Command[] = [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }];
    await runReifySequence(session, chain, trace);

    // The first real build must have produced at least one real artifact.
    const snapshot = await session.snapshot();
    assert.ok(snapshot.runs.length >= 1, "真 run 必须落进 run store");
    assert.ok(
      snapshot.runs.some((run) => run.artifacts.length >= 1),
      "真 build 必须留下 artifact",
    );

    // SIGKILL the real kernel mid-build; recovery must be proven by another build.
    await runReifySequence(session, [{ kind: "fault", name: "killKernelDuringBuild", params: {} }], trace);
    assert.ok(
      session.history.recoveries.some((recovery) => recovery.after === "killKernelDuringBuild"),
      "killKernel 之后必须有一次真 build 成功作为恢复证据",
    );
  });
});

test("reify chaos: 控制面被杀后 kernel 成孤儿会被 no-orphan-kernel 抓到", async (t) => {
  await withRealSession(async (session) => {
    await runReifySequence(session, REIFY_SETUP, new ReifyTrace());
    const conversation = session.conversation(0);

    const live = session.spawnCall("model-build", {
      source: "slow_part.py",
      output: "build/slow-orphan.step",
      validation: "fast",
      sessionId: conversation,
    });
    const kernel = await Promise.race([session.waitForOwnedKernel(live.pid, 30_000), live.done.then(() => null)]);
    assert.ok(kernel, "真 model-build 必须起一个真 cadctl kernel");

    process.kill(live.pid, "SIGKILL");
    await live.done;

    // Give the kernel the real shutdown grace, then look for a real leak.
    let orphan = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      orphan = session.orphanKernels().find((candidate) => candidate.pid === kernel!.pid) ?? null;
      if (orphan) break;
      await sleep(200);
    }
    if (!orphan) {
      t.skip("控制面死后 kernel 也跟着退了，这轮没留下孤儿");
      return;
    }

    const snapshot = await session.snapshot();
    let violation: InvariantViolation | null = null;
    try {
      await checkReifyInvariants({ session, snapshot, now: Date.now() });
    } catch (error) {
      if (error instanceof InvariantViolation) violation = error;
      else throw error;
    }
    assert.ok(violation, "孤儿 kernel 必须触发 invariant");
    assert.equal(violation!.invariant, "no-orphan-kernel");
  });
});

test("reify chaos: recover 抛普通 Error 会变成 recovery-convergence，不会静默过", async () => {
  await withRealSession(async (session, trace) => {
    const broken: ReifyFaultDefinition = {
      name: "brokenRecover",
      description: "recover 会抛普通 Error 的假故障（只用来测 runner 不吞错）",
      arbitrary: fc.constant({}),
      describe: () => "brokenRecover",
      inject: async () => undefined,
      recover: async () => {
        throw new Error("workflow-current 自己报错");
      },
    };
    await assert.rejects(
      () => recoverInjectedFaults(session, [broken], trace),
      (error: unknown) =>
        error instanceof InvariantViolation &&
        error.invariant === "recovery-convergence" &&
        error.detail.includes("workflow-current 自己报错"),
    );
  });
});

test("reify chaos: recover 之后会再取一次真状态重查 invariant", async () => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(session, REIFY_SETUP, trace);
    assert.ok(
      trace.timeline.some((entry) => entry.command === "post-recovery"),
      "recover 之后必须有一次真 snapshot + invariant check",
    );
  });
});

test("reify chaos: 盘上 artifact 被改后 artifact-integrity 能抓到", async () => {
  await withRealSession(async (session, trace) => {
    const chain: Command[] = [
      ...REIFY_SETUP,
      { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } },
    ];
    await runReifySequence(session, chain, trace);

    // Read the artifact once while it is still clean, the way a snapshot does
    // during a run.
    const before = await session.snapshot();
    const run = before.runs.find((candidate) => candidate.artifacts.length > 0);
    assert.ok(run, "真 build 必须留下 artifact");
    const artifact = run!.artifacts[0]!;
    await checkReifyInvariants({ session, snapshot: before, now: Date.now() });

    // Tamper with the file on disk without touching the recorded sha.
    writeFileSync(resolve(session.project, artifact.path), "tampered\n");
    const after = await session.snapshot();
    const tampered = after.runs.find((candidate) => candidate.id === run!.id)!.artifacts[0]!;
    assert.notEqual(tampered.sha256OnDisk, tampered.sha256, "盘上 digest 必须重算，不能读旧缓存");

    let violation: InvariantViolation | null = null;
    try {
      await checkReifyInvariants({ session, snapshot: after, now: Date.now() });
    } catch (error) {
      if (error instanceof InvariantViolation) violation = error;
      else throw error;
    }
    assert.ok(violation, "被改过的 artifact 必须触发 invariant");
    assert.equal(violation!.invariant, "artifact-integrity");
  });
});

test("reify chaos: seed + path 能精确重放同一条生成序列", async () => {
  const arbitrary = buildReifySequenceArbitrary(reifyActionDefinitions, reifyFaultDefinitions, 6);
  const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    if (commands.some((command) => command.name === "build")) throw new Error("这条序列里有 build");
  });
  const details = await fc.check(property, { numRuns: 50, seed: 4242 });
  assert.ok(details.failed && details.counterexamplePath, "必须先真找到一条失败序列");
  const shrunk = details.counterexample![0];

  const replay: Command[] = [];
  const replayProperty = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    replay.push(...commands);
  });
  const replayed = await fc.check(replayProperty, {
    seed: details.seed,
    path: details.counterexamplePath!,
    endOnFailure: true,
    numRuns: 1,
  });
  assert.ok(!replayed.failed, "重放的序列本身不该失败");
  assert.deepEqual(replay, shrunk, "seed + path 必须重放出 shrink 之后的那条序列");
});
