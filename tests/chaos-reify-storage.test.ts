// Real file-state boundary: run state files, desktop projection, partial writes and on-disk artifacts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { InvariantViolation } from "../chaos/types.ts";
import { reifyFaultDefinitions } from "../chaos/reify/faults/index.ts";
import { inspectDesktopProjection } from "../chaos/reify/inspect.ts";
import { checkReifyInvariants, reifyInvariantDefinitions } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP } from "../chaos/reify/model.ts";
import { injectReifyFault, runReifySequence, startReifySession } from "../chaos/reify/runner.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";
import { withRealSession, withRuntime, driveRunThroughRuntime } from "./chaos-reify-support.ts";

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

test("reify chaos: Desktop 投影和 backend 真状态一致", async () => {
  await withRuntime(async (session, runtime) => {
    const conversation = session.conversation(0);
    const runId = await driveRunThroughRuntime(runtime, conversation);
    const pair = inspectDesktopProjection(session.project, session.canonical, runId);
    assert.ok(pair.projection.present, "真 authority 必须写 .pi-cad/status.json");
    assert.equal(pair.projection.runId, runId);
    assert.ok(pair.consistent, pair.mismatch ?? "投影和 backend 必须一致");
  });
});

test("reify chaos: 真状态文件少了 / 坏了，harness 的破坏不会被算成产品缺陷，恢复后系统还能真 build", async (t) => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      trace,
    );
    const runId = ((await session.call("workflow-current", { sessionId: session.conversation(0) })) as { runId?: string }).runId;
    assert.ok(runId, "setup 之后必须有真 run");

    const definition = reifyFaultDefinitions.find((fault) => fault.name === "missingRunStateFile")!;
    const stateFile = join(session.runDir(runId!), "state.json");
    assert.ok(existsSync(stateFile), "真 run state 文件必须在");

    // A file/state fault: the real run state file really goes missing.
    const outcome = await injectReifyFault(session, definition, { kind: "fault", name: "missingRunStateFile", params: {} }, trace);
    if (outcome.status === "NotApplicable") {
      t.skip(`这一轮没法挪走 state 文件：${outcome.reason}`);
      return;
    }
    assert.equal(outcome.status, "Injected");
    assert.ok(!existsSync(stateFile), "state.json 必须真的被挪走");
    assert.ok(session.harnessDamage.runs.has(runId!), "damage 必须被登记下来");

    // While the harness holds the file broken, the product must not be blamed.
    await checkReifyInvariants({ session, snapshot: await session.snapshot(), now: Date.now() });

    // Recovery really puts the file back, and the same run really still works.
    await definition.recover({ session, trace, params: {} });
    assert.ok(existsSync(stateFile), "恢复必须把 state.json 放回去");
    assert.ok(!session.harnessDamage.runs.has(runId!), "恢复之后 damage 必须清掉");
    const recovered = (await session.call("workflow-current", { sessionId: session.conversation(0) })) as { runId?: string };
    assert.equal(recovered.runId, runId, "恢复之后同一个 run 还得在");
  });
});

test("reify chaos: 真状态读不出来时 precondition 直接失败，不会被当成不适用", async () => {
  const session = await ReifySession.start();
  const trace = new ReifyTrace();
  try {
    // The real state source (workflow-current) really fails; the harness must
    // report InjectionFailed, never a silent NotApplicable.
    (session as unknown as { call: () => Promise<never> }).call = async () => {
      throw new Error("workflow-current 真读挂了");
    };
    for (const name of ["killKernelDuringBuild", "raceUserActionDuringKernelFault", "raceLegalOrderSwap"]) {
      const definition = reifyFaultDefinitions.find((fault) => fault.name === name)!;
      const outcome = await injectReifyFault(session, definition, { kind: "fault", name, params: { conversationIndex: 0 } }, trace);
      assert.equal(outcome.status, "InjectionFailed", `${name} 读不到真状态必须算注入失败：${JSON.stringify(outcome)}`);
      assert.ok(outcome.reason?.includes("workflow-current 真读挂了"), `${name} 必须原样带上真异常：${outcome.reason}`);
    }
    assert.ok(
      !session.faultOutcomes.some((entry) => entry.status === "NotApplicable"),
      "读不到真状态不能变成不适用",
    );
  } finally {
    await session.close().catch(() => undefined);
  }
});

test("reify chaos: harness 自己占着坏的 state 文件时，terminal-state-stable 不判产品", async () => {
  await withRealSession(async (session, trace) => {
    // The real product walks the run to done. Checked after every step, so the
    // terminal state is recorded in the session history.
    await runReifySequence(
      session,
      [
        { kind: "action", name: "startRun", params: { conversationIndex: 0 } },
        { kind: "action", name: "commitPlan", params: { conversationIndex: 0 } },
        { kind: "action", name: "advance", params: { event: "plan_ready", conversationIndex: 0 } },
        { kind: "action", name: "commitPlan", params: { conversationIndex: 0 } },
        { kind: "action", name: "stopRun", params: { conversationIndex: 0 } },
      ],
      trace,
    );
    const before = await session.snapshot();
    const runId = before.runs[0]?.id;
    assert.ok(runId, "setup 之后必须有真 run");
    await checkReifyInvariants({ session, snapshot: before, now: Date.now() });
    assert.equal(session.history.runStatus.get(runId!), "done", "前提：产品真的到过 done，并被 invariant 记了下来");

    // The harness damages the state file the same way the faults do: it marks
    // the run as its own damage and writes a stale copy that reads "active".
    // Reading that copy after "done" is exactly the "到过 done，现在又是 active" shape.
    const stateFile = join(session.runDir(runId!), "state.json");
    const original = readFileSync(stateFile);
    const stale = { ...(JSON.parse(original.toString()) as Record<string, unknown>), status: "active", phase: "cook" };
    const terminalStable = reifyInvariantDefinitions.find((definition) => definition.name === "terminal-state-stable")!;
    try {
      session.markDamagedRun(runId!);
      writeFileSync(stateFile, JSON.stringify(stale));
      const damaged = await session.snapshot();
      assert.equal(damaged.runs.find((run) => run.id === runId)?.status, "active", "坏文件真的读成了 active");

      // While the harness holds the file broken, neither the terminal check nor
      // the full catalog blames the product.
      await terminalStable.check({ session, snapshot: damaged, now: Date.now() });
      await checkReifyInvariants({ session, snapshot: damaged, now: Date.now() });

      // Control: once the damage is no longer ours, the same snapshot is a real
      // product regression and the terminal check must say so.
      session.unmarkDamagedRun(runId!);
      await assert.rejects(
        terminalStable.check({ session, snapshot: damaged, now: Date.now() }),
        (error: unknown) => error instanceof InvariantViolation && error.invariant === "terminal-state-stable",
      );
    } finally {
      session.unmarkDamagedRun(runId!);
      writeFileSync(stateFile, original);
    }
  });
});

test("reify chaos: 两个 file-state 故障叠在一起，harness 不会造出假的 fault-outcome-honest", async (t) => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      trace,
    );
    const runId = ((await session.call("workflow-current", { sessionId: session.conversation(0) })) as { runId?: string }).runId;
    assert.ok(runId, "setup 之后必须有真 run");
    const stateFile = join(session.runDir(runId!), "state.json");
    assert.ok(existsSync(stateFile), "真 run state 文件必须在");
    const artifactCount = (await session.snapshot()).runs.find((run) => run.id === runId)?.artifacts.length ?? 0;
    assert.ok(artifactCount > 0, "setup 的真 build 必须留下 artifact");

    const unreadable = reifyFaultDefinitions.find((fault) => fault.name === "unreadableRunStateFile")!;
    const partial = reifyFaultDefinitions.find((fault) => fault.name === "partialStateWrite")!;

    const first = await injectReifyFault(session, unreadable, { kind: "fault", name: "unreadableRunStateFile", params: {} }, trace);
    if (first.status === "NotApplicable") {
      t.skip(`这一轮造不出「读不到」：${first.reason}`);
      return;
    }
    assert.equal(first.status, "Injected");

    // The composite case the campaign really generated: a previous fault made
    // the state file unreadable, so a partially-written state file is not a
    // scenario that exists. It must be "not applicable", never an injection
    // failure that then reads as a product bug.
    const second = await injectReifyFault(session, partial, { kind: "fault", name: "partialStateWrite", params: {} }, trace);
    assert.equal(second.status, "NotApplicable", "读不到的文件上加「写一半」必须明说不适用");
    assert.match(second.reason ?? "", /读不了或写不了/);

    await unreadable.recover({ session, trace, params: {} });
    assert.ok(JSON.parse(readFileSync(stateFile, "utf8")), "恢复之后 state.json 必须还是能读的 JSON");

    // The fault itself still works when nothing else is holding the file.
    const intact = readFileSync(stateFile);
    const alone = await injectReifyFault(session, partial, { kind: "fault", name: "partialStateWrite", params: {} }, trace);
    assert.equal(alone.status, "Injected", "没有别的故障时「写一半」要真的注入");
    assert.ok(readFileSync(stateFile).length < intact.length, "state.json 必须真的被截短");

    // Truncating a second time would overwrite the only intact copy, so the
    // second injection must refuse instead of silently destroying the original.
    const twice = await injectReifyFault(session, partial, { kind: "fault", name: "partialStateWrite", params: {} }, trace);
    assert.equal(twice.status, "NotApplicable", "已经截过一次就不能再截，否则原件就没了");

    await partial.recover({ session, trace, params: {} });
    // A second truncation would have overwritten the only intact copy, so the
    // recovered state must still describe the same run with the same artifacts.
    await checkReifyInvariants({ session, snapshot: await session.snapshot(), now: Date.now() });
    const recovered = (await session.call("workflow-current", { sessionId: session.conversation(0) })) as { runId?: string };
    assert.equal(recovered.runId, runId, "恢复之后同一个 run 还得在");
    const restored = (await session.snapshot()).runs.find((run) => run.id === runId);
    assert.equal(restored?.artifacts.length, artifactCount, "恢复之后 run 上的 artifact 不能少");
    assert.ok(!session.harnessDamage.runs.has(runId!), "恢复之后 damage 必须清掉");
  });
});

test("reify chaos: partialStateWrite recovery 不覆盖故障期间已经写回的有效新状态", async () => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      trace,
    );
    const view = (await session.call("workflow-current", { sessionId: session.conversation(0) })) as { runId?: string };
    assert.ok(view.runId, "setup 之后必须有真 run");
    const stateFile = join(session.runDir(view.runId!), "state.json");
    const partial = reifyFaultDefinitions.find((fault) => fault.name === "partialStateWrite")!;

    const outcome = await injectReifyFault(
      session,
      partial,
      { kind: "fault", name: "partialStateWrite", params: {} },
      trace,
    );
    assert.equal(outcome.status, "Injected", `partialStateWrite 必须真的注入：${JSON.stringify(outcome)}`);

    const backup = `${stateFile}.chaos-original`;
    assert.ok(existsSync(backup), "注入后必须保留完整备份");
    const newer = JSON.parse(readFileSync(backup, "utf8")) as { createdAt?: string };
    newer.createdAt = "2099-01-01T00:00:00.000Z";
    writeFileSync(stateFile, JSON.stringify(newer, null, 2));

    await partial.recover({ session, trace, params: {} });

    assert.ok(
      trace.notes.some((note) => note.includes("已被产品写回有效新状态，保留当前文件")),
      "recovery 必须识别当前 state 已经是有效新写入，而不是恢复注入前备份",
    );
    assert.ok(JSON.parse(readFileSync(stateFile, "utf8")), "真 recovery build 之后 state.json 仍必须是有效 JSON");
    assert.ok(!existsSync(backup), "恢复后旧备份必须清掉");
    assert.ok(!session.harnessDamage.runs.has(view.runId!), "恢复后 harness damage 标记必须清掉");
  });
});

test("reify chaos: one-shot authority 下 missingDesktopProjection 明确 NotApplicable", async () => {
  const session = await startReifySession(false);
  const trace = new ReifyTrace();
  try {
    await runReifySequence(session, REIFY_SETUP, trace);
    const missing = reifyFaultDefinitions.find((fault) => fault.name === "missingDesktopProjection")!;
    const outcome = await injectReifyFault(
      session,
      missing,
      { kind: "fault", name: "missingDesktopProjection", params: {} },
      trace,
    );
    assert.equal(outcome.status, "NotApplicable", JSON.stringify(outcome));
    assert.match(outcome.reason ?? "", /Desktop runtime|one-shot authority/);
    assert.ok(!session.activeFaults.includes("missingDesktopProjection"), "不适用时不能留下 armed fault");
  } finally {
    await session.close().catch(() => undefined);
  }
});
