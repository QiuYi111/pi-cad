// Race boundary: a real user action or a second conversation lands during a fault.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reifyFaultDefinitions } from "../chaos/reify/faults/index.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_MULTI_CONVERSATION_SETUP, REIFY_SETUP } from "../chaos/reify/model.ts";
import { injectReifyFault, recoverInjectedFaults, runReifySequence, startReifySession } from "../chaos/reify/runner.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";
import { withRealSession } from "./chaos-reify-support.ts";

test("reify chaos: race 故障真的跑多步，并留下可 replay 的命令序列", async () => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      trace,
    );
    const command: Command = { kind: "fault", name: "raceLegalOrderSwap", params: { first: "build", conversationIndex: 0 } };
    await runReifySequence(session, [command], trace);
    const outcome = session.faultOutcomes.find((entry) => entry.name === "raceLegalOrderSwap");
    assert.equal(outcome?.status, "Injected", `race 必须真的注入：${JSON.stringify(outcome)}`);
    const raced = trace.entries.filter((entry) => entry.kind === "command" && entry.name.startsWith("race:"));
    assert.ok(raced.length >= 2, `race 必须真的跑了两步以上，实际 ${raced.length}`);
    // The race is an ordinary generated command, so replay/shrink still see it.
    assert.ok(trace.executed.some((executed) => executed.name === "raceLegalOrderSwap"));
  });
});

test("reify chaos: 多会话 race 严格要两个能 build 的会话，准备动作是序列里的真命令", async () => {
  const races = [
    ["raceTwoConversationsBuild", {}],
    ["raceCrossConversationFault", { faultedIndex: 1 }],
  ] as const;

  // No second conversation: the fault says so instead of producing one.
  await withRealSession(async (session, trace) => {
    await runReifySequence(session, REIFY_SETUP, trace);
    assert.equal(session.conversations.length, 1, "这段序列只开了一个会话");
    for (const [name, params] of races) {
      const definition = reifyFaultDefinitions.find((fault) => fault.name === name)!;
      const outcome = await injectReifyFault(session, definition, { kind: "fault", name, params }, trace);
      assert.equal(outcome.status, "NotApplicable", `${name} 只有一个会话时必须如实不适用：${JSON.stringify(outcome)}`);
      assert.equal(session.conversations.length, 1, `${name} 不能自己造第二个会话`);
    }
  });

  // With the explicit preparation the round really asks for, both inject.
  await withRealSession(async (session, trace) => {
    await runReifySequence(session, REIFY_SETUP, trace);
    await runReifySequence(session, REIFY_MULTI_CONVERSATION_SETUP, trace);
    assert.equal(session.conversations.length, 2, "准备序列必须真的开出第二个会话");
    for (const [name, params] of races) {
      const definition = reifyFaultDefinitions.find((fault) => fault.name === name)!;
      const outcome = await injectReifyFault(session, definition, { kind: "fault", name, params }, trace);
      assert.equal(outcome.status, "Injected", `${name} 准备好两会话后必须真的注入：${JSON.stringify(outcome)}`);
      await recoverInjectedFaults(session, [{ definition, params }], trace);
      await checkReifyInvariants({ session, snapshot: await session.snapshot(), now: Date.now() });
    }
  });
});

test("reify chaos: 两个合法操作真按生成器选的顺序跑，A→B 与 B→A 不一样", async () => {
  await withRealSession(async (session) => {
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      new ReifyTrace(),
    );
    const definition = reifyFaultDefinitions.find((fault) => fault.name === "raceLegalOrderSwap")!;
    const injectOutcome = (before: number) =>
      session.faultOutcomes.slice(before).find((entry) => entry.name === "raceLegalOrderSwap" && entry.phase === "inject");
    const orderOf = async (first: string): Promise<string[]> => {
      const trace = new ReifyTrace();
      const before = session.faultOutcomes.length;
      await runReifySequence(session, [{ kind: "fault", name: "raceLegalOrderSwap", params: { first, conversationIndex: 0 } }], trace);
      const outcome = injectOutcome(before);
      assert.equal(outcome?.status, "Injected", `${first} 分支必须真的注入：${JSON.stringify(outcome)}`);
      return trace.entries.filter((entry) => entry.kind === "command" && entry.name.startsWith("race:")).map((entry) => entry.name);
    };

    const buildFirst = await orderOf("build");
    const commitFirst = await orderOf("commitPlan");
    assert.deepEqual(buildFirst, ["race:retryBuild", "race:commitPlan"], `first=build 必须真先 build：${buildFirst.join("→")}`);
    assert.deepEqual(commitFirst, ["race:commitPlan", "race:retryBuild"], `first=commitPlan 必须真先 commit：${commitFirst.join("→")}`);
    assert.notDeepEqual(buildFirst, commitFirst, "两个生成分支的执行顺序必须真的不同");
  });
});

test("reify chaos: transition race 先验真合法，产品在重启前拒绝就不算注入", async () => {
  const session = await startReifySession(true);
  const trace = new ReifyTrace();
  try {
    const conversation = session.conversation(0);
    await runReifySequence(session, REIFY_SETUP, trace);
    const phase = ((await session.call("workflow-current", { sessionId: conversation })) as { phase?: string } | null)?.phase;
    assert.equal(phase, "cook", `setup 之后必须在 cook：${phase}`);

    const definition = reifyFaultDefinitions.find((fault) => fault.name === "raceRestartDuringTransition")!;
    // cook 阶段不接受 plan_ready：不合法的事件不能算一次真的 transition race。
    const illegal = await injectReifyFault(session, definition, { kind: "fault", name: definition.name, params: { event: "plan_ready" } }, trace);
    assert.equal(illegal.status, "NotApplicable", `不合法的事件必须明说不适用：${JSON.stringify(illegal)}`);
    assert.ok(illegal.reason?.includes("plan_ready"), `不适用必须说清哪个事件不合法：${illegal.reason}`);
    assert.ok(!session.activeFaults.includes("raceRestartDuringTransition"), "不适用就不能留在已注入状态");

    // cook 阶段真合法的 finished 才真的和重启同时发生。
    const beforeLegal = session.faultOutcomes.length;
    await runReifySequence(session, [{ kind: "fault", name: "raceRestartDuringTransition", params: { event: "finished" } }], trace);
    const legal = session.faultOutcomes
      .slice(beforeLegal)
      .find((entry) => entry.name === "raceRestartDuringTransition" && entry.phase === "inject");
    assert.equal(legal?.status, "Injected", `合法的事件必须真的注入：${JSON.stringify(legal)}`);

    // 记录里必须带上产品自己的答案，不能只写“我重启了”。
    const note = trace.entries.find((entry) => entry.kind === "note" && entry.name === "raceRestartDuringTransition");
    assert.ok(note, "必须记录 transition 与重启各自的真结果");
    const answer = (note!.detail as { answer?: { result?: unknown; error?: string } }).answer;
    assert.ok(answer && (answer.result !== undefined || typeof answer.error === "string"), `记录必须带产品答案：${JSON.stringify(note!.detail)}`);
  } finally {
    await session.close().catch(() => undefined);
  }
});

test("reify chaos: 常驻 runtime 面不暴露 viewer-catalog，race 明说不适用", async () => {
  const session = await startReifySession(true);
  const trace = new ReifyTrace();
  try {
    await runReifySequence(session, REIFY_SETUP, trace);
    const definition = reifyFaultDefinitions.find((fault) => fault.name === "raceUserActionDuringKernelFault")!;
    const outcome = await injectReifyFault(
      session,
      definition,
      { kind: "fault", name: definition.name, params: { action: "viewerCatalog", conversationIndex: 0 } },
      trace,
    );
    // 常驻 runtime（authority sidecar）不暴露 viewer-catalog，只有一次性 CLI
    // 控制面才有。以前这里会抛 "author endpoint does not expose operation:
    // viewer-catalog"，再被记成 fault-outcome-honest —— 那是 harness 自己的
    // 问题，不是产品失败。
    assert.equal(outcome.status, "NotApplicable", JSON.stringify(outcome));
    assert.match(outcome.reason ?? "", /viewer-catalog/);
    assert.ok(!session.activeFaults.includes(definition.name));
  } finally {
    await session.close().catch(() => undefined);
  }
});
