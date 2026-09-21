import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import fc from "fast-check";
import { request } from "undici";

import { InvariantViolation } from "../chaos/types.ts";
import { reifyActionDefinitions } from "../chaos/reify/actions.ts";
import { loadReifyArtifact, saveReifyArtifact } from "../chaos/reify/artifacts.ts";
import { inspectReifyComponents } from "../chaos/reify/components.ts";
import { FAULT_BOUNDARIES, providerFaultDefinitions, raceFaultDefinitions, reifyFaultDefinitions } from "../chaos/reify/faults.ts";
import { inspectDesktopProjection, inspectProviderBoundary, readProviderCredentials, resolvePrimeAgentRepo } from "../chaos/reify/inspect.ts";
import { checkReifyInvariants } from "../chaos/reify/invariants.ts";
import { REIFY_SETUP, buildReifySequenceArbitrary } from "../chaos/reify/model.ts";
import { applyCredentialFault, observeCredential, restoreCredentialSandbox, seedCredentialSandbox } from "../chaos/reify/provider.ts";
import { ProviderFaultProxy } from "../chaos/reify/provider-proxy.ts";
import { injectReifyFault, recoverInjectedFaults, runReifySequence, startReifySession } from "../chaos/reify/runner.ts";
import { ReifyRuntime } from "../chaos/reify/runtime.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import type { Command } from "../chaos/reify/model.ts";
import { FaultNotApplicable } from "../chaos/reify/types.ts";
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

test("reify chaos: 真 provider fault proxy 的 timeout/reset/latency/截断/状态码都是真的", async () => {
  const upstream = createServer((incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true, path: incoming.url }));
  });
  await new Promise<void>((accept) => upstream.listen(0, "127.0.0.1", () => accept()));
  const port = (upstream.address() as { port: number }).port;
  const upstreamConfig = { protocol: "http" as const, host: "127.0.0.1", port };
  try {
    // Baseline: no fault -> the real upstream answer comes back through the proxy.
    const clean = await ProviderFaultProxy.start(upstreamConfig, { mode: "latency", delayMs: 0 });
    const cleanResponse = await request(clean.urlFor("/models"));
    assert.equal(cleanResponse.statusCode, 200);
    await cleanResponse.body.dump();
    await clean.close();

    // timeout/hang: the client's own timeout is what fails.
    const hung = await ProviderFaultProxy.start(upstreamConfig, { mode: "hang" });
    await assert.rejects(() => request(hung.urlFor("/models"), { headersTimeout: 300, bodyTimeout: 300 }));
    assert.equal(hung.observations.faults, 1);
    await hung.close();

    // reset: a real RST, not a clean EOF.
    const reset = await ProviderFaultProxy.start(upstreamConfig, { mode: "reset" });
    await assert.rejects(
      () => request(reset.urlFor("/models")),
      (error: unknown) => /reset|socket hang up|other side closed/i.test(String((error as Error).message)),
    );
    await reset.close();

    // truncated stream: prefix of the real body, then the connection breaks.
    const cut = await ProviderFaultProxy.start(upstreamConfig, { mode: "truncate", bytes: 4 });
    const cutResponse = await request(cut.urlFor("/models"));
    assert.equal(cutResponse.statusCode, 200);
    await assert.rejects(() => cutResponse.body.arrayBuffer());
    assert.equal(cut.observations.faults, 1);
    await cut.close();

    // status fault: a real HTTP status code reaches the caller.
    const limited = await ProviderFaultProxy.start(upstreamConfig, { mode: "status", status: 429 });
    const limitedResponse = await request(limited.urlFor("/models"));
    assert.equal(limitedResponse.statusCode, 429);
    await limitedResponse.body.dump();
    await limited.close();
  } finally {
    upstream.closeAllConnections?.();
    await new Promise<void>((accept) => upstream.close(() => accept()));
  }
});

test("reify chaos: 真 credential 副本过期 / 删除 / 清空后，真读取代码判成不可用", async () => {
  const source = mkdtempSync(join(tmpdir(), "chaos-reify-cred-"));
  const session = await ReifySession.start();
  try {
    writeFileSync(
      join(source, "auth.json"),
      JSON.stringify({
        zai: { type: "api_key", key: "real-api-key-value" },
        "openai-codex": { type: "oauth", access: "real-access-value", expires: 4102444800000 },
      }),
    );
    const selection = { provider: "openai-codex", model: "gpt-5" };

    const expired = seedCredentialSandbox(session, source);
    const expiredResult = await applyCredentialFault(expired, selection, "expire");
    assert.equal(expiredResult.before.expired, false, "真 OAuth 凭证一开始没过期");
    assert.equal(expiredResult.after.expired, true, "过期故障之后真读取代码必须判成已过期");
    restoreCredentialSandbox(expired);
    const restored = await observeCredential(expired, selection);
    assert.equal(restored.described.expired, false, "恢复之后必须回到没过期");

    const dropped = seedCredentialSandbox(session, source);
    const droppedResult = await applyCredentialFault(dropped, selection, "drop");
    assert.equal(droppedResult.before.present, true);
    assert.equal(droppedResult.after.present, false, "删除故障之后凭证不能还在");
    restoreCredentialSandbox(dropped);

    const blanked = seedCredentialSandbox(session, source);
    const blankedResult = await applyCredentialFault(blanked, { provider: "zai", model: "glm-4.6" }, "blank");
    assert.equal(blankedResult.after.hasCredentials, false, "清空 secret 之后不能还算已认证");
    restoreCredentialSandbox(blanked);
  } finally {
    await session.close().catch(() => undefined);
    rmSync(source, { recursive: true, force: true });
  }
});

test("reify chaos: 凭证副本里没有选中的 provider 时，凭证故障明说不适用而不是乱打", async () => {
  const previous = { provider: process.env.CHAOS_REIFY_PROVIDER, model: process.env.CHAOS_REIFY_MODEL };
  await withRealSession(async (session, trace) => {
    // Force a selection the chaos-owned credential copy cannot have.
    process.env.CHAOS_REIFY_PROVIDER = "chaos-provider-that-does-not-exist";
    process.env.CHAOS_REIFY_MODEL = "chaos-model";
    const definition = reifyFaultDefinitions.find((fault) => fault.name === "providerCredentialDropped")!;
    const outcome = await injectReifyFault(session, definition, { kind: "fault", name: definition.name, params: {} }, trace);
    assert.equal(outcome.status, "NotApplicable", `不能乱打：${JSON.stringify(outcome)}`);
    assert.ok(outcome.reason && outcome.reason.length > 0, "不适用必须给理由");
    assert.ok(!session.activeFaults.includes(definition.name), "不适用就不能留在已注入状态");
  });
  if (previous.provider === undefined) delete process.env.CHAOS_REIFY_PROVIDER;
  else process.env.CHAOS_REIFY_PROVIDER = previous.provider;
  if (previous.model === undefined) delete process.env.CHAOS_REIFY_MODEL;
  else process.env.CHAOS_REIFY_MODEL = previous.model;
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

const runIdOf = (view: unknown): string | null => {
  const runId = (view as { runId?: string } | null)?.runId;
  return typeof runId === "string" ? runId : null;
};

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
