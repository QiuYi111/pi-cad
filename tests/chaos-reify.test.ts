import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import fc from "fast-check";

import { InvariantViolation } from "../chaos/types.ts";
import { reifyActionDefinitions } from "../chaos/reify/actions.ts";
import { loadReifyArtifact, saveReifyArtifact } from "../chaos/reify/artifacts.ts";
import { inspectReifyComponents } from "../chaos/reify/components.ts";
import { reifyFaultDefinitions } from "../chaos/reify/faults.ts";
import { inspectDesktopProjection, inspectProviderBoundary, readProviderCredentials, resolvePrimeAgentRepo } from "../chaos/reify/inspect.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP, buildReifySequenceArbitrary } from "../chaos/reify/model.ts";
import { recoverInjectedFaults, runReifySequence } from "../chaos/reify/runner.ts";
import { ReifyRuntime } from "../chaos/reify/runtime.ts";
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

async function withRuntime<T>(body: (session: ReifySession, runtime: ReifyRuntime) => Promise<T>): Promise<T> {
  const session = await ReifySession.start();
  const runtime = await ReifyRuntime.start({
    project: session.project,
    runtimeDirectory: join(session.root, "runtime"),
    env: session.env,
  });
  session.registerAuthorityPid(runtime.pid);
  try {
    return await body(session, runtime);
  } finally {
    await runtime.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

/** Drive a real run to `cook` through the runtime's own socket. */
async function driveRunThroughRuntime(runtime: ReifyRuntime, conversation: string): Promise<string> {
  const view = (await runtime.call("workflow-start", { id: "mechanical.default", sessionId: conversation })) as { runId?: string };
  assert.ok(view.runId, "真 runtime 必须真建 run");
  await runtime.call("commit", { name: "plan", sessionId: conversation });
  await runtime.call("workflow-advance", { event: "plan_ready", sessionId: conversation });
  return view.runId!;
}

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

test("reify chaos: provider 边界读到真选择和凭证，且不泄露 token", async () => {
  const boundary = await inspectProviderBoundary({ probe: false });
  assert.ok(boundary.selection.provider.length > 0, "必须读到 provider 选择");
  assert.ok(boundary.selection.source.length > 0, "必须说明选择来源");
  assert.ok(Array.isArray(boundary.credentials));
  for (const credential of boundary.credentials) {
    assert.ok(!("access" in credential) && !("key" in credential), "凭证对象不能带 token 值");
    assert.equal(typeof credential.hasCredentials, "boolean");
  }
  if (resolvePrimeAgentRepo()) {
    // The real Prime model registry resolves a real endpoint for the selection.
    assert.ok(boundary.baseUrl === null || boundary.baseUrl.startsWith("http"), "baseUrl 必须是真 URL");
  }
});

test("reify chaos: provider 网络 probe 默认只读，只有显式 opt-in 才联网", async () => {
  const previous = process.env.CHAOS_REIFY_PROVIDER_PROBE;
  try {
    delete process.env.CHAOS_REIFY_PROVIDER_PROBE;
    // No call-site flag and no env opt-in: this must stay read-only and never
    // fire a real provider request.
    const byDefault = await inspectProviderBoundary();
    assert.equal(byDefault.probe.status, null, "默认不能发 provider 请求");
    assert.equal(byDefault.probe.ok, false);
    if (byDefault.probe.url) {
      assert.ok(byDefault.probe.skipped, "默认必须说明为什么没发请求");
    }
    // An explicit opt-out at the call site is also read-only.
    const forcedOff = await inspectProviderBoundary({ probe: false });
    assert.equal(forcedOff.probe.status, null, "显式关闭也不能发 provider 请求");
    // The shared component inspector keeps the same read-only default, so an
    // artifact capture can never trigger a real provider request.
    const session = await ReifySession.start();
    try {
      const components = await inspectReifyComponents(session);
      assert.equal(components.provider.probe.status, null, "capture 路径默认不能发 provider 请求");
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.CHAOS_REIFY_PROVIDER_PROBE;
    else process.env.CHAOS_REIFY_PROVIDER_PROBE = previous;
  }
});

test("reify chaos: 真 auth.json 格式（api_key / oauth）都算已认证，且不泄露 token", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-reify-auth-"));
  try {
    // The exact shapes Prime writes (docs/providers.md): API-key providers use
    // `type: "api_key"` + `key`, OAuth providers use `type: "oauth"` + `access`.
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        zai: { type: "api_key", key: "real-api-key-value" },
        "openai-codex": { type: "oauth", access: "real-access-value", refresh: "real-refresh-value", expires: 4102444800000 },
      }),
    );
    const credentials = readProviderCredentials(dir);
    const byId = new Map(credentials.map((credential) => [credential.id, credential]));
    assert.equal(byId.get("zai")?.type, "api_key");
    assert.equal(byId.get("zai")?.hasCredentials, true, "真 api_key 凭证必须算已认证");
    assert.equal(byId.get("openai-codex")?.type, "oauth");
    assert.equal(byId.get("openai-codex")?.hasCredentials, true, "真 oauth 凭证必须算已认证");
    for (const credential of credentials) {
      assert.ok(!("access" in credential) && !("key" in credential), "凭证对象不能带 token 值");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reify chaos: provider 边界对真 api_key 判为已认证，且默认只读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-reify-auth-"));
  try {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "real-api-key-value" } }));
    const boundary = await inspectProviderBoundary({ agentDir: dir, override: { provider: "zai", model: "glm-4.6" }, probe: false });
    assert.equal(boundary.probe.status, null, "默认只读，不能发请求");
    assert.equal(boundary.probe.authenticated, true, "真 api_key 凭证必须判为已认证（显式 probe 才会带真 header）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
