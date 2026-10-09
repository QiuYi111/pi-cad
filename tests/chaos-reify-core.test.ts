// Cross-cutting real-Reify checks: invariants, recovery convergence, artifacts and replay, and the fault and action space.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { InvariantViolation } from "../chaos/types.ts";
import { reifyActionDefinitions } from "../chaos/reify/actions.ts";
import { loadReifyArtifact, saveReifyArtifact } from "../chaos/reify/artifacts.ts";
import { inspectReifyComponents } from "../chaos/reify/components.ts";
import { FAULT_BOUNDARIES, providerFaultDefinitions, raceFaultDefinitions, reifyFaultDefinitions } from "../chaos/reify/faults/index.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP, buildReifySequenceArbitrary } from "../chaos/reify/model.ts";
import {
  injectReifyFault,
  recoverInjectedFaults,
  replayReifyArtifact,
  runReifySequence,
  startReifySession,
} from "../chaos/reify/runner.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";
import { FaultNotApplicable } from "../chaos/reify/types.ts";
import type { ReifyFaultDefinition } from "../chaos/reify/types.ts";
import { withRealSession, buildCapable } from "./chaos-reify-support.ts";

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

test("reify chaos: seed + path 能精确重放原路径，shrink 后的序列仍复现同一个失败", async () => {
  const arbitrary = buildReifySequenceArbitrary(reifyActionDefinitions, reifyFaultDefinitions, 6);
  const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    if (commands.some((command) => command.name === "build")) throw new Error("这条序列里有 build");
  });
  const details = await fc.check(property, { numRuns: 50, seed: 4242 });
  assert.ok(details.failed && details.counterexamplePath, "必须先真找到一条失败序列");
  const shrunk = details.counterexample![0];

  // `path` replays the failing path the run recorded, so two replays must be
  // bit-identical: that is what makes `replay <artifact> --seed` trustworthy.
  const replayOnce = async (): Promise<Command[]> => {
    const seen: Command[] = [];
    const replayProperty = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
      seen.push(...commands);
    });
    const replayed = await fc.check(replayProperty, {
      seed: details.seed,
      path: details.counterexamplePath!,
      endOnFailure: true,
      numRuns: 1,
    });
    assert.ok(!replayed.failed, "重放的序列本身不该失败");
    return seen;
  };
  const first = await replayOnce();
  const second = await replayOnce();
  assert.deepEqual(second, first, "seed + path 重放必须可重复");

  // The shrunk counterexample is the minimized reproduction, so it must still
  // fail the very same property (and be no longer than the replayed path).
  const fails = (commands: Command[]) => commands.some((command) => command.name === "build");
  assert.ok(fails(shrunk), "shrink 之后必须还留着真正的失败");
  assert.ok(shrunk.length <= first.length, "shrink 之后不能比原始失败路径更长");
});

test("reify chaos: artifact 能带上新组件的真观测", async () => {
  const session = await ReifySession.start();
  let file: string | undefined;
  try {
    const components = await inspectReifyComponents(session);
    assert.ok(components.wsl.command.length > 0, "WSL 探针必须给出可执行命令");
    file = saveReifyArtifact({
      schema: 1,
      sut: "reify",
      createdAt: new Date().toISOString(),
      invariant: "test",
      detail: "component carrier",
      seed: 1,
      replayPath: "",
      maxCommands: 1,
      originalSequence: [],
      shrunkSequence: [],
      replaySequence: [],
      reproducible: false,
      actionSequence: [],
      faultSequence: [],
      requests: [],
      ids: { conversations: [], runs: [], kernels: [] },
      stateTimeline: [],
      logs: [],
      recoveries: [],
      project: { root: session.root, project: session.project, canonical: session.canonical, workflowHome: session.workflowHome },
      components,
    });
    const loaded = loadReifyArtifact(file);
    assert.ok(loaded.components, "artifact 必须带回 components");
    assert.equal(loaded.components!.identities.project, components.identities.project);
    assert.ok(loaded.components!.provider.selection.provider.length > 0);
  } finally {
    if (file) rmSync(file, { force: true });
    await session.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// RES-387：扩大真实 action / fault 空间
// ---------------------------------------------------------------------------

test("reify chaos: action / fault 空间够大，且覆盖四类真边界", () => {
  assert.ok(reifyActionDefinitions.length >= 15, `真 action 至少 15 个，现在 ${reifyActionDefinitions.length}`);
  assert.ok(reifyFaultDefinitions.length >= 15, `真 fault 至少 15 个，现在 ${reifyFaultDefinitions.length}`);
  const boundaries = new Set(Object.values(FAULT_BOUNDARIES));
  for (const required of ["process", "file-state", "provider-oauth", "race"]) {
    assert.ok(boundaries.has(required as never), `必须覆盖 ${required}`);
  }
  assert.ok(raceFaultDefinitions.length >= 5, `race / 时序组合至少 5 组，现在 ${raceFaultDefinitions.length}`);
  assert.ok(providerFaultDefinitions.length >= 5, "provider/OAuth 边界至少 5 个故障模式");
  for (const fault of reifyFaultDefinitions) {
    assert.ok(FAULT_BOUNDARIES[fault.name], `fault ${fault.name} 必须标出它打的边界`);
    assert.ok(fault.description.length > 0);
  }
  // A race is not a single-step fault: it has to decide applicability from real
  // state (so it can be honestly NotApplicable) and it must be one of the
  // multi-step combinations rather than a lone signal.
  for (const race of raceFaultDefinitions) {
    assert.equal(typeof race.precondition, "function", `race ${race.name} 必须先判适用性`);
  }
});

test("reify chaos: fault 结果语义分明，真异常不会被当成不适用", async () => {
  await withRealSession(async (session, trace) => {
    const def = (name: string, inject: ReifyFaultDefinition["inject"], precondition?: ReifyFaultDefinition["precondition"]): ReifyFaultDefinition => ({
      name,
      description: name,
      arbitrary: fc.constant({}),
      describe: () => name,
      ...(precondition ? { precondition } : {}),
      inject,
      recover: async () => undefined,
    });

    // 1. Real-state precondition says there is nothing to hit -> NotApplicable.
    const skipped = await injectReifyFault(
      session,
      def("fakeSkipped", async () => {
        throw new Error("不适用就不该真的去注入");
      }, async () => ({ applicable: false, reason: "没有可打的目标" })),
      { kind: "fault", name: "fakeSkipped", params: {} },
      trace,
    );
    assert.equal(skipped.status, "NotApplicable");
    assert.equal(skipped.reason, "没有可打的目标");

    // 2. A real system exception during injection is a failure, never a skip.
    const failed = await injectReifyFault(
      session,
      def("fakeRealError", async () => {
        throw new Error("真系统自己报错");
      }),
      { kind: "fault", name: "fakeRealError", params: {} },
      trace,
    );
    assert.equal(failed.status, "InjectionFailed");
    assert.ok(failed.reason?.includes("真系统自己报错"), `原因必须原样带上：${failed.reason}`);

    // 3. A precondition that itself blows up is also a failure, not a skip.
    const preconditionBlewUp = await injectReifyFault(
      session,
      def("fakePreconditionError", async () => undefined, async () => {
        throw new Error("读真状态失败");
      }),
      { kind: "fault", name: "fakePreconditionError", params: {} },
      trace,
    );
    assert.equal(preconditionBlewUp.status, "InjectionFailed");
    assert.ok(preconditionBlewUp.reason?.includes("读真状态失败"));

    // 4. A deliberate mid-inject "not applicable" is still NotApplicable.
    const deliberate = await injectReifyFault(
      session,
      def("fakeVanished", async () => {
        throw new FaultNotApplicable("目标在注入前消失了", { reason: "gone" });
      }),
      { kind: "fault", name: "fakeVanished", params: {} },
      trace,
    );
    assert.equal(deliberate.status, "NotApplicable");
    assert.equal(deliberate.reason, "目标在注入前消失了");

    // 5. Every outcome is recorded, and InjectionFailed can never pass the
    //    invariants silently.
    assert.ok(session.faultOutcomes.some((outcome) => outcome.status === "NotApplicable" && outcome.reason));
    assert.ok(session.faultOutcomes.some((outcome) => outcome.status === "InjectionFailed"));
    const snapshot = await session.snapshot();
    await assert.rejects(
      () => checkReifyInvariants({ session, snapshot, now: Date.now() }),
      (error: unknown) => error instanceof InvariantViolation || (error as { invariant?: string })?.invariant === "fault-outcome-honest",
    );
  });
});

test("reify chaos: openConversation 起的新会话真的能 build，不是停在 plan", async () => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(session, REIFY_SETUP, trace);
    await runReifySequence(session, [{ kind: "action", name: "openConversation", params: {} }], trace);

    const second = session.conversation(1);
    assert.notEqual(second, session.conversation(0), "必须真的有第二个会话");
    // Only `workflow-start` left the new run in `plan`, where `model.build` is
    // not granted. A round like that is not a working conversation, and every
    // multi-conversation race silently degraded to the single-conversation
    // case and reported NotApplicable forever.
    assert.ok(await buildCapable(session, second), `新会话 ${second} 必须真的能 build`);

    // And the build really happens in the second conversation, not twice in
    // the first one.
    const before = session.requests.length;
    await runReifySequence(session, [{ kind: "action", name: "multiConversationBuild", params: {} }], trace);
    const built = session.requests.slice(before).filter((entry) => entry.op === "model-build");
    assert.deepEqual(
      [...new Set(built.map((entry) => entry.conversation))].sort(),
      [session.conversation(0), second].sort(),
      `两个会话必须各自真 build 一次：${built.map((entry) => entry.conversation).join(",")}`,
    );
    assert.ok(built.every((entry) => entry.ok), `两个会话的 build 都要成功：${JSON.stringify(built)}`);
  });
});

test("reify chaos: 一个 run 做完后新开 run，旧 run 是历史，不算归属串了", async (t) => {
  await withRealSession(async (session, trace) => {
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      trace,
    );
    const first = ((await session.call("workflow-current", { sessionId: session.conversation(0) })) as { runId?: string }).runId;
    assert.ok(first, "setup 之后必须有真 run");

    await runReifySequence(session, [{ kind: "action", name: "stopRun", params: { conversationIndex: 0 } }], trace);
    const afterStop = (await session.call("workflow-current", { sessionId: session.conversation(0) })) as { status?: string };
    if (afterStop.status !== "done") {
      t.skip(`stopRun 之后状态是 ${afterStop.status}，这一轮走不到历史 run 的场景`);
      return;
    }

    // 真产品允许做完的 run 被新 run 取代（active 的会被拒）。旧 run 这时没人绑着，
    // 它是历史，不是归属错误；只有「active run 没人绑」才是问题。
    await runReifySequence(session, [{ kind: "action", name: "startRun", params: { conversationIndex: 0 } }], trace);
    const snapshot = await session.snapshot();
    const second = snapshot.conversations.find((conversation) => conversation.id === session.conversation(0))?.runId;
    assert.ok(second && second !== first, `新 run 必须真的换了会话绑的 run：${second}`);
    assert.ok(snapshot.runs.some((run) => run.id === first), "旧 run 还得留在 run store 里当历史");
  });
});

test("reify chaos: 一轮跑得久不算没恢复，只有要求恢复后还挂着才算", async () => {
  const session = await ReifySession.start();
  try {
    const snapshot = await session.snapshot();
    session.armFault("killKernelDuringBuild");
    session.history.armedSince.set("killKernelDuringBuild", Date.now() - 30 * 60_000);
    // 故障故意挂着跟完整条序列：跑得久不是失败信号。
    await checkReifyInvariants({ session, snapshot, now: Date.now() });

    // 已经要求恢复、过了预算还挂着，才是真的没收敛。
    session.history.recoveryStartedAt = Date.now() - 30 * 60_000;
    await assert.rejects(
      () => checkReifyInvariants({ session, snapshot, now: Date.now() }),
      /recovery-convergence/,
    );
  } finally {
    await session.close().catch(() => undefined);
  }
});

test("reify chaos: campaign 落盘的最小复现能直接当回归输入", async () => {
  // chaos/campaigns/<id>/regressions/ 是 campaign 自己 verify + shrink 出来的
  // 最小复现。res388-main-500 那条 no-orphan-kernel 跑在 63814903（RES-389 修
  // 之前），所以现在按序列和按 seed+path 都不该再复现；孤儿真漏回来这条会红。
  const artifact = resolve("chaos/campaigns/res388-main-500/regressions/c41b23f2c-no-orphan-kernel.json");
  const bySequence = await replayReifyArtifact(artifact, {});
  assert.equal(bySequence.ok, false, `RES-389 修完之后不该再复现：${bySequence.detail ?? ""}`);
  const bySeed = await replayReifyArtifact(artifact, { seed: true });
  assert.equal(bySeed.ok, false, `按 seed+path 也不该再复现：${bySeed.detail ?? ""}`);
});

test("reify chaos: 同一轮重复出现的 fault 第二次不适用时，只 recover 真注入的那次", async () => {
  // RES-399：res390-main-1000 的 regression artifact。同一轮里
  // missingDesktopProjection 出现两次，第二次没东西可删、如实报 NotApplicable，
  // 但 runner 原来按 `activeFaults` 判断「这步注入成功没有」，把它也算成注入过，
  // 于是 recover 多跑一次：那次没 arm 记录，只能拿空路径去 existsSync，必然失败，
  // 误报 recovery-convergence。
  const artifactFile = resolve("chaos/campaigns/res390-main-1000/regressions/ca17c3c29-recovery-convergence.json");
  assert.ok(existsSync(artifactFile), "这条 regression artifact 必须留在仓库里");
  const artifact = loadReifyArtifact(artifactFile);
  assert.equal(artifact.invariant, "recovery-convergence");
  assert.equal(artifact.runtimeMode, true, "这条失败记的是常驻 runtime 模式");
  assert.deepEqual(
    artifact.replaySequence.map((command) => command.name),
    ["startRun", "commitPlan", "advance", "missingDesktopProjection", "missingDesktopProjection", "advance", "missingRunStateFile"],
    "重放的就是「同 fault 出现两次」那条序列",
  );

  // 序列重放和 seed+path 重放都不该再复现这条误报。
  const bySequence = await replayReifyArtifact(artifactFile, {});
  assert.equal(bySequence.ok, false, `修完之后不该再复现：${bySequence.detail ?? ""}`);
  const bySeed = await replayReifyArtifact(artifactFile, { seed: true });
  assert.equal(bySeed.ok, false, `按 seed+path 也不该再复现：${bySeed.detail ?? ""}`);

  // 同一段序列再跑一次，直接看真相：第二次确实没注入，所以只该回收第一次。
  const session = await startReifySession(true);
  const trace = new ReifyTrace();
  try {
    await runReifySequence(session, artifact.replaySequence, trace);
    const injections = session.faultOutcomes.filter(
      (outcome) => outcome.name === "missingDesktopProjection" && outcome.phase === "inject",
    );
    assert.deepEqual(
      injections.map((outcome) => outcome.status),
      ["Injected", "NotApplicable"],
      `这一轮的注入结果必须是「真注入一次 + 如实不适用一次」：${JSON.stringify(injections)}`,
    );
    const recoveries = session.faultOutcomes.filter(
      (outcome) => outcome.name === "missingDesktopProjection" && outcome.phase === "recover",
    );
    assert.deepEqual(
      recoveries.map((outcome) => outcome.status),
      ["Recovered"],
      `只该回收真注入过的那一次，不能多跑：${JSON.stringify(recoveries)}`,
    );
    assert.deepEqual(session.activeFaults, [], `回收之后不能还挂着 fault：${session.activeFaults.join(", ")}`);
  } finally {
    await session.close().catch(() => undefined);
  }
});
