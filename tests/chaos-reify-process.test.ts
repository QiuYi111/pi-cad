// Real process boundary: kill, pause and restart the kernel, authority, runtime and Prime processes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { request } from "undici";
import { loadReifyArtifact } from "../chaos/reify/artifacts.ts";
import { inspectReifyComponents } from "../chaos/reify/components.ts";
import { reifyFaultDefinitions } from "../chaos/reify/faults/index.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP } from "../chaos/reify/model.ts";
import {
  injectReifyFault,
  recoverInjectedFaults,
  replayReifyArtifact,
  runReifySequence,
  startReifySession,
} from "../chaos/reify/runner.ts";
import { ReifyRuntime } from "../chaos/reify/runtime.ts";
import { ReifySession, listKernelProcesses } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";
import { waitForBuildChild, waitForRuntimeKernel, withRealSession, withRuntime, driveRunThroughRuntime, runIdOf } from "./chaos-reify-support.ts";
import { isProcessAlive, processState, processTree, sleep, waitForProcessesGone, waitForStopped } from "../chaos/support/process.ts";

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

test("reify chaos: 控制面被 SIGKILL 后 kernel 跟着退，不留孤儿", async () => {
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
    // The worker is the kernel's own process here; the forked child is what
    // proves the fault lands while a real build is in flight.
    const buildChild = await waitForBuildChild(session, kernel.pid);
    assert.ok(buildChild, "真 model-build 必须在 warm kernel 里 fork 出一个 build 子进程");
    const tree = processTree(kernel.pid);

    process.kill(live.pid, "SIGKILL");
    await live.done;

    const stubborn = await waitForProcessesGone(tree, 15_000);
    assert.deepEqual(stubborn, [], `控制面死后它起的 kernel 树必须自己退干净，还活着：${stubborn.join(", ")}`);
    assert.deepEqual(session.orphanKernels(), [], "不该再有孤儿 kernel");
    const snapshot = await session.snapshot();
    await checkReifyInvariants({ session, snapshot, now: Date.now() });
  });
});

test("reify chaos: 正常 stop 也带走 kernel 和 fork 出来的 build 子进程", async () => {
  await withRuntime(async (session, runtime) => {
    const conversation = session.conversation(0);
    await driveRunThroughRuntime(runtime, conversation);
    // A stop kills the request in flight, so the rejection is expected and is
    // handled from the moment the call is made.
    const pending = runtime.call("model-build", {
      source: "slow_part.py",
      output: "build/slow-stop.step",
      validation: "fast",
      sessionId: conversation,
    }).catch(() => undefined);
    const kernel = await waitForRuntimeKernel(session, runtime.pid);
    assert.ok(kernel, "真 runtime 必须起一个真 cadctl kernel");
    const buildChild = await waitForBuildChild(session, kernel!.pid);
    assert.ok(buildChild, "真 build 必须在 warm kernel 里 fork 出一个 build 子进程");
    const tree = processTree(kernel!.pid);

    await runtime.stop();
    await pending;

    const stubborn = await waitForProcessesGone(tree, 15_000);
    assert.deepEqual(stubborn, [], `正常 stop 也必须带走整棵树，还活着：${stubborn.join(", ")}`);
  });
});

test("reify chaos: runtime 重启后旧 kernel 退干净，run 还在", async () => {
  await withRuntime(async (session, runtime) => {
    const conversation = session.conversation(0);
    const runId = await driveRunThroughRuntime(runtime, conversation);
    const pending = runtime.call("model-build", {
      source: "slow_part.py",
      output: "build/slow-restart.step",
      validation: "fast",
      sessionId: conversation,
    }).catch(() => undefined);
    const kernel = await waitForRuntimeKernel(session, runtime.pid);
    assert.ok(kernel, "真 runtime 必须起一个真 cadctl kernel");
    const buildChild = await waitForBuildChild(session, kernel!.pid);
    assert.ok(buildChild, "真 build 必须在 warm kernel 里 fork 出一个 build 子进程");
    const tree = processTree(kernel!.pid);

    const previousPid = runtime.pid;
    const restarted = await runtime.restart();
    session.registerAuthorityPid(runtime.pid);
    await pending;

    assert.notEqual(restarted.pid, previousPid, "重启后 runtime pid 必须变");
    const stubborn = await waitForProcessesGone(tree, 15_000);
    assert.deepEqual(stubborn, [], `重启后旧 kernel 树必须退干净，还活着：${stubborn.join(", ")}`);
    const after = (await runtime.call("workflow-current", { sessionId: conversation })) as { runId?: string };
    assert.equal(after.runId, runId, "run 跨 runtime 重启必须还在");
  });
});

test("reify chaos: 杀一个 runtime 不会带走别的 run 的 kernel", async () => {
  const first = await ReifySession.start();
  const second = await ReifySession.start();
  const runtimeFirst = await ReifyRuntime.start({
    project: first.project,
    runtimeDirectory: join(first.root, "runtime"),
    env: first.env,
  });
  const runtimeSecond = await ReifyRuntime.start({
    project: second.project,
    runtimeDirectory: join(second.root, "runtime"),
    env: second.env,
  });
  first.registerAuthorityPid(runtimeFirst.pid);
  second.registerAuthorityPid(runtimeSecond.pid);
  try {
    const conversationFirst = first.conversation(0);
    const conversationSecond = second.conversation(0);
    await driveRunThroughRuntime(runtimeFirst, conversationFirst);
    await driveRunThroughRuntime(runtimeSecond, conversationSecond);
    const pendingFirst = runtimeFirst.call("model-build", {
      source: "slow_part.py",
      output: "build/slow-a.step",
      validation: "fast",
      sessionId: conversationFirst,
    }).catch(() => undefined);
    const pendingSecond = runtimeSecond.call("model-build", {
      source: "slow_part.py",
      output: "build/slow-b.step",
      validation: "fast",
      sessionId: conversationSecond,
    });
    const kernelFirst = await waitForRuntimeKernel(first, runtimeFirst.pid);
    const kernelSecond = await waitForRuntimeKernel(second, runtimeSecond.pid);
    assert.ok(kernelFirst && kernelSecond, "两个 run 必须各有自己的真 kernel");
    const buildFirst = await waitForBuildChild(first, kernelFirst!.pid);
    const buildSecond = await waitForBuildChild(second, kernelSecond!.pid);
    assert.ok(buildFirst && buildSecond, "两个 run 都必须在真 build 途中");
    const treeFirst = processTree(kernelFirst!.pid);
    const treeSecond = processTree(kernelSecond!.pid);

    // SIGKILL one owner. Only its own kernel may converge.
    process.kill(runtimeFirst.pid, "SIGKILL");
    const leakedFirst = await waitForProcessesGone(treeFirst, 15_000);
    assert.deepEqual(leakedFirst, [], `被杀 runtime 的 kernel 树必须退干净，还活着：${leakedFirst.join(", ")}`);

    const survivors = treeSecond.filter((pid) => isProcessAlive(pid));
    assert.equal(
      survivors.length,
      treeSecond.length,
      `别的 run 的 kernel 不能被误杀：${treeSecond.filter((pid) => !isProcessAlive(pid)).join(", ")}`,
    );
    // The untouched run still finishes its real build.
    await pendingSecond;
    assert.ok(listKernelProcesses().some((process) => process.pid === kernelSecond!.pid), "另一个 kernel 必须还在");
    await pendingFirst;
  } finally {
    await runtimeFirst.close().catch(() => undefined);
    await runtimeSecond.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
  }
});

test("reify chaos: 被 SIGSTOP 的 warm kernel 在 owner 被杀后不用 SIGCONT 也自己退", async () => {
  // RES-390 round #92 的形态：真 build 途中把整个 kernel 树 SIGSTOP，然后把
  // owner（这里是一次性控制面）SIGKILL。Python watchdog 线程跟进程一起停住，
  // 所以只有内核级 owner-death 信号能救场：worker 必须自己退，且不用 SIGCONT。
  await withRealSession(async (session) => {
    await runReifySequence(session, REIFY_SETUP, new ReifyTrace());
    const conversation = session.conversation(0);

    const live = session.spawnCall("model-build", {
      source: "slow_part.py",
      output: "build/slow-paused.step",
      validation: "fast",
      sessionId: conversation,
    });
    const kernel = await Promise.race([session.waitForOwnedKernel(live.pid, 30_000), live.done.then(() => null)]);
    assert.ok(kernel, "真 model-build 必须起一个真 cadctl kernel");
    const buildChild = await waitForBuildChild(session, kernel.pid);
    assert.ok(buildChild, "真 model-build 必须在 warm kernel 里 fork 出一个 build 子进程");
    const tree = processTree(kernel.pid);
    assert.ok(tree.includes(buildChild), "build 子进程必须在 kernel 树里");

    // Exactly what pauseKernelDuringBuild does: the process group and every
    // pid in the tree. The whole kernel is stopped, threads included.
    session.killKernel(kernel.pid, "SIGSTOP");
    assert.ok(await waitForStopped(tree, 5_000), `kernel 树必须真停住：${tree.map((pid) => `${pid}=${processState(pid)}`).join(", ")}`);

    process.kill(live.pid, "SIGKILL");
    await live.done;

    const stubborn = await waitForProcessesGone(tree, 15_000);
    assert.deepEqual(stubborn, [], `owner 死后被暂停的 kernel 树必须自己退干净，还活着：${stubborn.join(", ")}`);
    assert.deepEqual(session.orphanKernels(), [], "不该留下孤儿 kernel");
    const snapshot = await session.snapshot();
    await checkReifyInvariants({ session, snapshot, now: Date.now() });
  });
});

test("reify chaos: RES-390 round #92 的 no-orphan-kernel artifact 重放后不再复现", async () => {
  // RES-390 主 soak round #92 的两条原 artifact，症状和序列完全一样：seed
  // 1959249991，常驻 runtime 模式，startRun→commitPlan→advance→
  // pauseKernelDuringBuild→restartRuntimeDuringBuild。
  // - `05-24-59`：探索那一轮的 artifact（issue 正文引用过）；
  // - `06-38-11`：复跑那轮 round #92 的 raw artifactPath。
  // 产品修好之后，两条的同一段序列都必须跑完，不再触发 no-orphan-kernel。
  const artifacts = [
    "tests/fixtures/chaos/2026-09-22T05-24-59-068Z-reify-no-orphan-kernel.json",
    "tests/fixtures/chaos/2026-09-22T06-38-11-069Z-reify-no-orphan-kernel.json",
  ];
  const sequence = ["startRun", "commitPlan", "advance", "pauseKernelDuringBuild", "restartRuntimeDuringBuild"];
  for (const relative of artifacts) {
    const artifactFile = resolve(relative);
    assert.ok(existsSync(artifactFile), `${relative} 必须留在仓库里`);
    const artifact = loadReifyArtifact(artifactFile);
    assert.equal(artifact.invariant, "no-orphan-kernel", relative);
    assert.equal(artifact.seed, 1959249991, relative);
    assert.equal(artifact.runtimeMode, true, `${relative} 记的是常驻 runtime 模式下的失败`);
    assert.deepEqual(artifact.replaySequence.map((command) => command.name), sequence, `${relative} 重放的是原序列`);

    const replayed = await replayReifyArtifact(artifactFile);
    assert.equal(
      replayed.observedInvariant,
      undefined,
      `${relative} 记的失败不该再出现：${replayed.detail ?? ""}`,
    );
  }
});

test("reify chaos: 原 no-orphan-kernel artifact 重放后不再复现", async () => {
  // RES-387 留下的那条失败 artifact。产品修好之后，同一段序列必须跑完，
  // 不再触发 no-orphan-kernel。`chaos reify replay` 的退出码语义是「有没有
  // 复现失败」，所以这里直接看重放结果，不借用它的退出码。
  const artifactFile = resolve("tests/fixtures/chaos/2026-09-21T15-49-19-348Z-reify-no-orphan-kernel.json");
  assert.ok(existsSync(artifactFile), "原始失败 artifact 必须留在仓库里");
  assert.equal(loadReifyArtifact(artifactFile).invariant, "no-orphan-kernel");

  const replayed = await replayReifyArtifact(artifactFile);
  assert.equal(
    replayed.observedInvariant,
    undefined,
    `这条 artifact 记的失败不该再出现：${replayed.detail ?? ""}`,
  );
});

test("reify chaos: 真 runtime 能起/停/重启，run 跨重启还在，kernel 真归属 runtime", async () => {
  await withRuntime(async (session, runtime) => {
    const conversation = session.conversation(0);
    const runId = await driveRunThroughRuntime(runtime, conversation);

    // A real slow build is in flight, so the kernel is a live child of the pid.
    const pending = runtime.call("model-build", {
      source: "slow_part.py",
      output: `build/slow-${conversation}.step`,
      validation: "fast",
      sessionId: conversation,
    });
    let ownedKernel = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !ownedKernel) {
      const snapshot = await session.snapshot();
      ownedKernel = snapshot.kernels.find((kernel) => kernel.ppid === runtime.pid) ?? null;
      if (!ownedKernel) await sleep(100);
    }
    const components = await inspectReifyComponents(session, {
      runtimes: [{ kind: "authority", pid: runtime.pid, startedAt: Date.now(), runIds: [runId] }],
      probeProvider: false,
    });
    await pending;

    assert.ok(ownedKernel, "真 runtime 必须起一个真 cadctl kernel");
    const edges = components.identities.edges.map((edge) => edge.kind);
    assert.ok(edges.includes("conversation->run"), "归属图必须有 conversation→run");
    assert.ok(edges.includes("run->runtime"), "归属图必须有 run→runtime");
    assert.ok(edges.includes("kernel->runtime"), "归属图必须有 kernel→runtime");
    assert.equal(components.identities.project, (await session.snapshot()).project.id);

    // Restart really replaces the runtime process without losing the run.
    const firstPid = runtime.pid;
    const restarted = await runtime.restart();
    session.registerAuthorityPid(runtime.pid);
    assert.notEqual(restarted.pid, firstPid, "重启后 runtime pid 必须变");
    const after = (await runtime.call("workflow-current", { sessionId: conversation })) as { runId?: string };
    assert.equal(after.runId, runId, "run 跨 runtime 重启必须还在");
  });
});

test("reify chaos: 带 conversationIndex 的 fault 真打对会话，conv#1 不会打到 conv#0", async () => {
  await withRealSession(async (session, trace) => {
    // conv-a: 真 run + 真 kernel。
    await runReifySequence(
      session,
      [...REIFY_SETUP, { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } }],
      trace,
    );
    const runA = runIdOf(await session.call("workflow-current", { sessionId: session.conversation(0) }));
    assert.ok(runA, "conv-a 必须有真 run");

    // 第二个真会话，也推到真 build 被允许的阶段。
    await runReifySequence(
      session,
      [
        { kind: "action", name: "openConversation", params: {} },
        { kind: "action", name: "commitPlan", params: { conversationIndex: 1 } },
        { kind: "action", name: "advance", params: { event: "plan_ready", conversationIndex: 1 } },
      ],
      trace,
    );
    const conversationB = session.conversation(1);
    assert.notEqual(conversationB, session.conversation(0), "必须真的有第二个会话");
    const runB = runIdOf(await session.call("workflow-current", { sessionId: conversationB }));
    assert.ok(runB && runB !== runA, `conv#1 必须有自己的 run：${runB}`);

    const entriesBefore = trace.entries.length;
    const requestsBefore = session.requests.length;
    const outcome = await injectReifyFault(
      session,
      reifyFaultDefinitions.find((fault) => fault.name === "killKernelDuringBuild")!,
      { kind: "fault", name: "killKernelDuringBuild", params: { conversationIndex: 1 } },
      trace,
    );
    assert.equal(outcome.status, "Injected", `fault 必须真的注入：${JSON.stringify(outcome)}`);

    // 真证据一：被杀的 build 请求真的发给了 conv#1。
    const builtFor = session.requests.slice(requestsBefore).filter((entry) => entry.op === "model-build").map((entry) => entry.conversation);
    assert.ok(builtFor.includes(conversationB), `被杀的真 build 必须发往 conv#1，实际 ${builtFor.join(",") || "无"}`);
    assert.ok(!builtFor.includes(session.conversation(0)), `conv#1 的故障不能打到 conv#0，实际 ${builtFor.join(",")}`);

    // 真证据二：记录里写的也是 conv#1 的 run。
    const recorded = JSON.stringify(trace.entries.slice(entriesBefore).map((entry) => entry.detail));
    assert.ok(recorded.includes(`conv=${conversationB}`), `记录必须写明真被打的会话：${recorded}`);
    assert.ok(recorded.includes(`run=${runB}`), `记录必须写明真被打的 run：${recorded}`);

    // 恢复也必须落在同一个会话上。
    const requestsBeforeRecovery = session.requests.length;
    await recoverInjectedFaults(
      session,
      [{ definition: reifyFaultDefinitions.find((fault) => fault.name === "killKernelDuringBuild")!, params: { conversationIndex: 1 } }],
      trace,
    );
    const recoveredFor = session.requests
      .slice(requestsBeforeRecovery)
      .filter((entry) => entry.op === "model-build")
      .map((entry) => entry.conversation);
    assert.ok(recoveredFor.includes(conversationB), `恢复的真 build 必须在 conv#1，实际 ${recoveredFor.join(",") || "无"}`);
  });
});

test("reify chaos: 别的故障杀掉 runtime 时，投影 recover 不会把 harness 的降级算成产品", async () => {
  // A session that really drives the resident runtime, the way a campaign
  // round does (`--runtime`), because the projection belongs to that backend.
  const session = await startReifySession(true);
  const trace = new ReifyTrace();
  try {
    await runReifySequence(session, REIFY_SETUP, trace);
    const kill = reifyFaultDefinitions.find((fault) => fault.name === "killRuntimeDuringBuild")!;
    const missing = reifyFaultDefinitions.find((fault) => fault.name === "missingDesktopProjection")!;
    const injected = [
      { definition: kill, params: {} },
      { definition: missing, params: {} },
    ];
    for (const { definition, params } of injected) {
      const outcome = await injectReifyFault(session, definition, { kind: "fault", name: definition.name, params }, trace);
      assert.equal(outcome.status, "Injected", `${definition.name} 必须真的注入：${JSON.stringify(outcome)}`);
    }
    // Hand them over in injection order: the runner recovers in reverse, so
    // the projection check runs while the runtime the other fault SIGKILLed is
    // still down. `session.call` would silently fall back to a one-shot
    // authority, which never owns the Desktop projection.
    await recoverInjectedFaults(session, injected, trace);
    const failed = session.faultOutcomes.filter((outcome) => outcome.status === "RecoveryFailed");
    assert.deepEqual(failed, [], `回收不能有失败：${JSON.stringify(failed)}`);
  } finally {
    await session.close().catch(() => undefined);
  }
});

test("reify chaos: runtime 暂停的时间窗收在 inject 里，后续真请求不会被 harness 自己卡住", async () => {
  const session = await startReifySession(true);
  const trace = new ReifyTrace();
  try {
    const conversation = session.conversation(0);
    await runReifySequence(session, REIFY_SETUP, trace);
    const definition = reifyFaultDefinitions.find((fault) => fault.name === "pauseRuntimeDuringBuild")!;
    const outcome = await injectReifyFault(session, definition, { kind: "fault", name: definition.name, params: {} }, trace);
    assert.equal(outcome.status, "Injected", `真 runtime 暂停必须真的注入：${JSON.stringify(outcome)}`);

    // 冻结是故障自己收的：后续真请求必须有人应答，不能卡在 harness 的 socket 超时上。
    const startedAt = Date.now();
    const view = await session.call("workflow-current", { sessionId: conversation });
    const elapsed = Date.now() - startedAt;
    assert.ok(runIdOf(view), "被暂停过的 runtime 恢复后必须还能答 workflow-current");
    assert.ok(elapsed < 30_000, `后续真请求不能卡在 harness 自己的超时上：${elapsed}ms`);
    assert.ok(
      !session.requests.some((request) => request.error === "Reify runtime socket timed out"),
      "不该出现 harness 自己造成的 socket 超时",
    );

    // 恢复仍然要用真 build 证明。
    await definition.recover({ session, trace, params: {} });
    assert.ok(
      session.history.recoveries.some((recovery) => recovery.after === "pauseRuntimeDuringBuild"),
      "暂停故障之后必须有一次真 build 作为恢复证据",
    );
  } finally {
    await session.close().catch(() => undefined);
  }
});
