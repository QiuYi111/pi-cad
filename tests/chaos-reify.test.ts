import assert from "node:assert/strict";
import { test } from "node:test";

import { InvariantViolation } from "../chaos/types.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP } from "../chaos/reify/model.ts";
import { runReifySequence } from "../chaos/reify/runner.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";

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
