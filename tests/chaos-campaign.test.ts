import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import fc from "fast-check";

import { loadCampaign, resolveCampaign } from "../chaos/campaign/campaign.ts";
import { aggregateCoverage } from "../chaos/campaign/coverage.ts";
import { buildRoundPlan, deriveRoundSeed } from "../chaos/campaign/plan.ts";
import { CAMPAIGN_PROFILES, NETWORK_PROVIDER_FAULTS, campaignFaultPool, profileFaultScope, resolveProfiles } from "../chaos/campaign/profiles.ts";
import { renderCampaignReport } from "../chaos/campaign/report.ts";
import { clusterFailures, failureSignature, normalizeText } from "../chaos/campaign/signature.ts";
import { assessClusterStability, classifyFailureVerdict, triageCluster } from "../chaos/campaign/triage.ts";
import type { CampaignReport, CampaignRound, FailureCluster } from "../chaos/campaign/types.ts";
import type { ReifyReplayResult, ReifyRunResult } from "../chaos/reify/runner.ts";
import { FAULT_BOUNDARIES } from "../chaos/reify/faults.ts";
import { reifyActionDefinitions } from "../chaos/reify/actions.ts";
import type { ReifyFailureArtifact } from "../chaos/reify/artifacts.ts";
import { REIFY_MULTI_CONVERSATION_SETUP, REIFY_SETUP, REIFY_WARM_KERNEL_SETUP, buildReifySequenceArbitrary, type Command } from "../chaos/reify/model.ts";
import { selectReifyFaults } from "../chaos/reify/runner.ts";

const command = (kind: "action" | "fault", name: string): Command => ({ kind, name, params: {} });

/** A failure artifact with only the fields the campaign reads. */
function artifact(overrides: Partial<ReifyFailureArtifact> & { detail: string; sequence: Command[] }): ReifyFailureArtifact {
  const { sequence, detail, ...rest } = overrides;
  return {
    schema: 1,
    sut: "reify",
    createdAt: "2026-09-22T00:00:00.000Z",
    invariant: "no-orphan-kernel",
    detail,
    seed: 1,
    replayPath: "0",
    maxCommands: 6,
    originalSequence: sequence,
    shrunkSequence: sequence,
    replaySequence: sequence,
    reproducible: false,
    actionSequence: sequence.filter((entry) => entry.kind === "action"),
    faultSequence: sequence.filter((entry) => entry.kind === "fault"),
    requests: [],
    ids: { conversations: [], runs: [], kernels: [] },
    stateTimeline: [],
    logs: ["控制面死后 kernel 1445 还在跑（孤儿进程）"],
    recoveries: [],
    project: { root: "/tmp/a", project: "/tmp/a", canonical: "/tmp/a", workflowHome: "/tmp/a" },
    ...rest,
  };
}

const failure = (path: string, roundIndex: number, seed: number, value: ReifyFailureArtifact) => ({
  roundIndex,
  seed,
  artifactPath: path,
  commit: "abc123",
  runtimeMode: false,
  artifact: value,
});

/** A cluster with just the fields triage reads. */
function clusterWith(overrides: Partial<FailureCluster> = {}): FailureCluster {
  return {
    id: "c1",
    signature: "sig",
    invariant: "no-orphan-kernel",
    boundary: "process",
    boundaries: ["process"],
    nature: "product",
    failingSteps: ["fault:killAuthorityDuringBuild"],
    reason: "N 个 kernel 的父控制面已经死了，进程还在：#(owner=#)",
    logSignatures: [],
    shapes: [],
    occurrences: 1,
    roundIndexes: [0],
    seeds: [1],
    artifactPaths: ["/tmp/a.json"],
    representative: "/tmp/a.json",
    firstSeenAt: "2026-09-22T00:00:00.000Z",
    lastSeenAt: "2026-09-22T00:00:00.000Z",
    runtimeModes: [false],
    commits: ["abc123"],
    verdict: "unverified",
    ...overrides,
  };
}

/** A run result that reproduced the cluster's invariant, shrunk to 4 steps. */
const reproducedRun: ReifyRunResult = {
  failed: true,
  seed: 1,
  numRuns: 1,
  invariant: "no-orphan-kernel",
  originalLength: 6,
  shrunkLength: 4,
  numShrinks: 2,
  invariants: ["no-orphan-kernel"],
  recoveries: [],
  faultOutcomes: [],
};

const replayResult = (ok: boolean, mode: ReifyReplayResult["mode"], detail?: string): ReifyReplayResult => ({
  ok,
  mode,
  expectedInvariant: "no-orphan-kernel",
  detail,
  steps: 4,
});

test("campaign plan: seed 可复现且不重复", () => {
  const first = Array.from({ length: 50 }, (_, index) => deriveRoundSeed(7000, index));
  const again = Array.from({ length: 50 }, (_, index) => deriveRoundSeed(7000, index));
  assert.deepEqual(first, again, "同一个 (base, index) 必须得到同一个 seed");
  assert.equal(new Set(first).size, first.length, "轮与轮之间 seed 不能撞");
  assert.notDeepEqual(first, Array.from({ length: 50 }, (_, index) => deriveRoundSeed(7001, index)), "换基数要换序列");
});

test("campaign plan: 每个 profile 都真的排进轮次，fault 池只含允许的 fault", () => {
  const profiles = resolveProfiles();
  const pool = campaignFaultPool(false);
  const plan = buildRoundPlan({ rounds: 200, seed: 7, maxCommands: 8, profiles, faultPool: pool, runtimeRatio: 0.5 });
  for (const profile of profiles) {
    assert.ok(plan.some((round) => round.profile === profile.name), `profile ${profile.name} 必须出现在计划里`);
  }
  for (const round of plan) {
    assert.ok(round.faultScope && round.faultScope.length > 0, "每轮都有具体 fault 池");
    for (const name of round.faultScope!) assert.ok(pool.includes(name), `${name} 不能超出 opt-in 之后的池`);
    assert.deepEqual(round.faultScope!, profileFaultScope(CAMPAIGN_PROFILES[round.profile]!, pool));
  }
  const runtimeRounds = plan.filter((round) => round.runtimeMode).length;
  assert.ok(runtimeRounds > 0 && runtimeRounds < plan.length, "runtimeRatio=0.5 要真的两种模式都有");
});

test("campaign: provider 传输故障默认不进池", () => {
  const closed = campaignFaultPool(false);
  const open = campaignFaultPool(true);
  for (const name of NETWORK_PROVIDER_FAULTS) {
    assert.ok(!closed.includes(name), `${name} 默认不能进池`);
    assert.ok(open.includes(name), `${name} 显式 opt-in 后要进池`);
  }
  assert.equal(open.length, Object.keys(FAULT_BOUNDARIES).length);
  // 凭证侧不是网络故障，默认就要覆盖到。
  assert.ok(closed.includes("providerCredentialExpired"));
});

test("campaign: targeted 模式必须点明 profile", () => {
  assert.throws(() => resolveCampaign({ mode: "targeted" }), /targeted/);
  const resolved = resolveCampaign({ mode: "targeted", profiles: ["kernel-lifecycle"], rounds: 3 });
  assert.deepEqual(resolved.manifest.profiles, ["kernel-lifecycle"]);
  assert.equal(resolved.plan.length, 3);
  assert.deepEqual(resolved.plan[0]!.faultScope, CAMPAIGN_PROFILES["kernel-lifecycle"]!.faults);
});

test("campaign: 多会话 profile 的准备动作真的进生成序列", () => {
  const prepared = resolveCampaign({ mode: "targeted", profiles: ["session-isolation"], rounds: 2 });
  assert.deepEqual(prepared.plan[0]!.preparation, REIFY_MULTI_CONVERSATION_SETUP, "多会话 profile 必须带准备序列");
  const plain = resolveCampaign({ mode: "targeted", profiles: ["kernel-lifecycle"], rounds: 1 });
  assert.deepEqual(plain.plan[0]!.preparation, [], "不需要准备的 profile 不能凭空加动作");

  const arbitrary = buildReifySequenceArbitrary(
    reifyActionDefinitions,
    selectReifyFaults(prepared.plan[0]!.faultScope ?? undefined),
    4,
    prepared.plan[0]!.preparation,
  );
  const prefix = [...REIFY_SETUP, ...REIFY_MULTI_CONVERSATION_SETUP];
  for (const sequence of fc.sample(arbitrary, { numRuns: 5, seed: 11 })) {
    assert.deepEqual(sequence.slice(0, prefix.length), prefix, "准备动作必须在每条生成序列最前面，replay/shrink 才看得到");
  }
});

test("campaign: idle-kernel profile 先用真 build 摆出 warm kernel", () => {
  // `killIdleKernel` 的 precondition 是「有活着的 warm kernel」，而 warm kernel
  // 只有真 build 过才会有。低命中就补真实 preparation，不是放宽 precondition。
  const prepared = resolveCampaign({ mode: "targeted", profiles: ["idle-kernel"], rounds: 2 });
  assert.deepEqual(prepared.plan[0]!.preparation, REIFY_WARM_KERNEL_SETUP, "idle-kernel profile 必须带真 build 准备");
  assert.deepEqual(
    prepared.plan[0]!.preparation.map((command) => command.name),
    ["build"],
    "准备动作必须是真的 build，不是直接摆一个假的 kernel",
  );
  assert.ok(
    CAMPAIGN_PROFILES["idle-kernel"]!.faults!.includes("killIdleKernel"),
    "准备就是为了这条 fault 能真注入",
  );

  const arbitrary = buildReifySequenceArbitrary(
    reifyActionDefinitions,
    selectReifyFaults(prepared.plan[0]!.faultScope ?? undefined),
    4,
    prepared.plan[0]!.preparation,
  );
  const prefix = [...REIFY_SETUP, ...REIFY_WARM_KERNEL_SETUP];
  for (const sequence of fc.sample(arbitrary, { numRuns: 5, seed: 13 })) {
    assert.deepEqual(sequence.slice(0, prefix.length), prefix, "真 build 必须排在 run 准备好之后、生成序列之前");
  }
});

test("campaign: shrink 能删掉 failure 用不上的 preparation", async () => {
  const arbitrary = buildReifySequenceArbitrary(
    // 生成池里去掉 openConversation，序列里出现的 openConversation 就只可能是 preparation。
    reifyActionDefinitions.filter((definition) => definition.name !== "openConversation"),
    selectReifyFaults(CAMPAIGN_PROFILES["session-isolation"]!.faults),
    4,
    REIFY_MULTI_CONVERSATION_SETUP,
  );
  const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    if (commands.some((command) => command.name === "build")) throw new Error("这条失败跟第二会话没关系");
  });

  // 没 shrink 的原始失败带着准备动作。
  const raw = await fc.check(property, { numRuns: 120, seed: 390, endOnFailure: true });
  assert.ok(raw.failed, "必须先真找到一条失败序列");
  assert.ok(
    raw.counterexample![0]!.some((command) => command.name === "openConversation"),
    `原始失败序列带着 preparation：${raw.counterexample![0]!.map((command) => command.name).join(" → ")}`,
  );

  const details = await fc.check(property, { numRuns: 120, seed: 390 });
  const shrunk = details.counterexample![0]!;
  assert.ok(shrunk.some((command) => command.name === "build"), "最小序列还得带着那条真失败");
  assert.ok(
    !shrunk.some((command) => command.name === "openConversation"),
    `用不上的 preparation 必须被缩掉：${shrunk.map((command) => command.name).join(" → ")}`,
  );
  assert.deepEqual(shrunk.slice(0, REIFY_SETUP.length), REIFY_SETUP, "setup 还得在最前面");
});

test("campaign: preparation 只是前缀，不改变同一 seed 生成的尾部", () => {
  const scope = CAMPAIGN_PROFILES["session-isolation"]!.faults;
  const prepared = buildReifySequenceArbitrary(reifyActionDefinitions, selectReifyFaults(scope), 4, REIFY_MULTI_CONVERSATION_SETUP);
  const plain = buildReifySequenceArbitrary(reifyActionDefinitions, selectReifyFaults(scope), 4);
  for (let seed = 1; seed <= 20; seed += 1) {
    const withPreparation = fc.sample(prepared, { numRuns: 3, seed });
    const withoutPreparation = fc.sample(plain, { numRuns: 3, seed });
    assert.deepEqual(
      withPreparation.map((sequence) => sequence.slice(REIFY_SETUP.length + REIFY_MULTI_CONVERSATION_SETUP.length)),
      withoutPreparation.map((sequence) => sequence.slice(REIFY_SETUP.length)),
      `seed=${seed} 时准备动作只能改前缀，不能改生成的尾部（老 artifact 的 seed/path 才不会变意思）`,
    );
  }
});

test("campaign: shrink 必须保留 failure 真依赖的 preparation", async () => {
  const arbitrary = buildReifySequenceArbitrary(
    reifyActionDefinitions.filter((definition) => definition.name !== "openConversation"),
    selectReifyFaults(CAMPAIGN_PROFILES["session-isolation"]!.faults),
    4,
    REIFY_MULTI_CONVERSATION_SETUP,
  );
  // 第二个会话准备好之后，双会话 race 才打得上：这条失败真依赖 preparation。
  const failure = (commands: Command[]): string | null => {
    let prepared = false;
    for (const command of commands) {
      if (command.name === "openConversation") prepared = true;
      if (command.name === "raceTwoConversationsBuild" && prepared) return "第二个会话在，双会话 race 才打得进去";
    }
    return null;
  };
  const property = fc.asyncProperty(arbitrary, async (commands: Command[]) => {
    const detail = failure(commands);
    if (detail) throw new Error(detail);
  });

  const raw = await fc.check(property, { numRuns: 200, seed: 390, endOnFailure: true });
  assert.ok(raw.failed, "必须先真找到一条失败序列");

  const details = await fc.check(property, { numRuns: 200, seed: 390 });
  const shrunk = details.counterexample![0]!;
  assert.ok(shrunk.some((command) => command.name === "raceTwoConversationsBuild"), "最小序列还带着那条 race");
  assert.deepEqual(shrunk.slice(0, REIFY_SETUP.length), REIFY_SETUP, "setup 还得在最前面");
  assert.equal(
    shrunk[REIFY_SETUP.length]!.name,
    "openConversation",
    `真依赖第二会话的 failure，shrink 后 preparation 必须留下：${shrunk.map((command) => command.name).join(" → ")}`,
  );
  // 反证：去掉 preparation，这条失败就不复现了，说明留下它不是因为 shrink 删不掉。
  const withoutPreparation = [...shrunk.slice(0, REIFY_SETUP.length), ...shrunk.slice(REIFY_SETUP.length + 1)];
  assert.equal(failure(withoutPreparation), null, "去掉 preparation 就不再复现");
});

test("campaign: nightly 默认就是 ≥500 轮", () => {
  const resolved = resolveCampaign({ mode: "nightly", campaignId: "x" });
  assert.equal(resolved.manifest.rounds, 500);
  assert.equal(resolved.plan.length, 500);
});

test("campaign dedupe: 同一个 bug 的不同 pid / seed 归成一个 cluster", () => {
  const sequence = [
    command("action", "startRun"),
    command("action", "commitPlan"),
    command("action", "advance"),
    command("fault", "killAuthorityDuringBuild"),
  ];
  const a = artifact({ detail: "1 个 kernel 的父控制面已经死了，进程还在：1445491(owner=1445434)", sequence });
  const b = artifact({
    detail: "1 个 kernel 的父控制面已经死了，进程还在：9911233(owner=9911200)",
    sequence: [...sequence.slice(0, 3), command("fault", "killAuthorityDuringBuild")],
    createdAt: "2026-09-22T01:00:00.000Z",
    logs: ["控制面死后 kernel 9911233 还在跑（孤儿进程）"],
  });
  assert.equal(failureSignature(a), failureSignature(b), "同一个 bug 必须同一个签名");
  const clusters = clusterFailures([failure("/tmp/a.json", 0, 11, a), failure("/tmp/b.json", 1, 22, b)]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.occurrences, 2);
  assert.deepEqual(clusters[0]!.seeds, [11, 22]);
  assert.equal(clusters[0]!.boundary, "process");
  assert.deepEqual(clusters[0]!.boundaries, ["process"]);
  assert.equal(clusters[0]!.nature, "product");
  assert.deepEqual(clusters[0]!.failingSteps, ["fault:killAuthorityDuringBuild"]);
  assert.equal(clusters[0]!.reason, "N 个 kernel 的父控制面已经死了，进程还在：#(owner=#)", "出现次数不算身份");
});

test("campaign dedupe: 同一个根因的不同触发合成一个，换了原因才分开", () => {
  const base = [command("action", "startRun"), command("action", "commitPlan"), command("action", "advance")];
  const authority = artifact({
    detail: "1 个 kernel 的父控制面已经死了，进程还在：1(owner=2)",
    sequence: [...base, command("fault", "killAuthorityDuringBuild"), command("action", "commitPlan")],
  });
  const runtime = artifact({
    detail: "1 个 kernel 的父控制面已经死了，进程还在：3(owner=4)",
    sequence: [...base, command("fault", "killRuntimeDuringBuild")],
    runtimeMode: true,
  });
  const clusters = clusterFailures([failure("/tmp/a.json", 0, 1, authority), failure("/tmp/r.json", 1, 2, runtime)]);
  assert.equal(clusters.length, 1, "同一个 invariant + 同一个原因 = 一个 unique failure");
  assert.deepEqual(clusters[0]!.boundaries, ["process"], "换边界的触发也算同一个根因");
  assert.deepEqual(clusters[0]!.failingSteps, [
    "action:commitPlan",
    "fault:killRuntimeDuringBuild",
  ], "在哪些步骤上收场要留下来给人看");
  assert.equal(clusters[0]!.shapes.length, 2, "触发它的形状要留下来给人看");

  const otherReason = artifact({
    invariant: "artifact-integrity",
    detail: "run 记的 artifact 不在盘上",
    sequence: [...base, command("fault", "partialStateWrite")],
  });
  assert.equal(clusterFailures([failure("/tmp/a.json", 0, 1, authority), failure("/tmp/f.json", 1, 2, otherReason)]).length, 2);
});

test("campaign: harness 自己踩自己标成 harness，不报成产品 bug", () => {
  const sequence = [
    command("action", "startRun"),
    command("fault", "unreadableRunStateFile"),
    command("fault", "partialStateWrite"),
  ];
  const harness = artifact({
    invariant: "fault-outcome-honest",
    detail: "fault partialStateWrite 注入失败：EACCES: permission denied, open '/tmp/reify-chaos-b8kVeQ/canonical/runs/v7-1790020333353-04333c50/state.json'",
    sequence,
    faultOutcomes: [{ name: "partialStateWrite", phase: "inject", status: "InjectionFailed", at: 1, reason: "EACCES: permission denied" }],
  });
  const other = artifact({
    invariant: "fault-outcome-honest",
    detail: "fault partialStateWrite 注入失败：EACCES: permission denied, open '/tmp/reify-chaos-ZZ99aa/canonical/runs/v7-1790020999999-99999aaa/state.json'",
    sequence,
    faultOutcomes: [{ name: "partialStateWrite", phase: "inject", status: "InjectionFailed", at: 2, reason: "EACCES: permission denied" }],
  });
  const clusters = clusterFailures([failure("/tmp/a.json", 0, 1, harness), failure("/tmp/b.json", 1, 2, other)]);
  assert.equal(clusters.length, 1, "换一个临时目录还是同一个 harness 问题");
  assert.equal(clusters[0]!.nature, "harness");
  assert.ok(!clusters[0]!.reason.includes("/tmp/reify-chaos-"), "临时目录不能留在签名里");
});

test("campaign report: 七个问题都有答案", () => {
  const rounds: CampaignRound[] = [
    {
      index: 0,
      seed: 1,
      profile: "process",
      runtimeMode: false,
      maxCommands: 4,
      faultScope: ["killKernelDuringBuild"],
      startedAt: "2026-09-22T00:00:00.000Z",
      durationMs: 1000,
      status: "failed",
      faultOutcomes: [
        { name: "killKernelDuringBuild", phase: "inject", status: "Injected", at: 1 },
        { name: "partialStateWrite", phase: "inject", status: "InjectionFailed", at: 2, reason: "EACCES" },
        { name: "killKernelDuringBuild", phase: "recover", status: "RecoveryFailed", at: 3, reason: "没恢复" },
      ],
      commands: ["action:startRun", "fault:killKernelDuringBuild"],
      injectedFaults: ["killKernelDuringBuild"],
      notApplicableFaults: [],
      boundariesHit: ["process"],
      componentsTouched: ["kernel"],
      recoveries: 0,
    },
  ];
  const coverage = aggregateCoverage(rounds, ["no-orphan-kernel"], ["process"]);
  const report: CampaignReport = {
    campaignId: "unit",
    createdAt: "2026-09-22T00:00:00.000Z",
    manifest: {
      campaignId: "unit",
      createdAt: "2026-09-22T00:00:00.000Z",
      mode: "short",
      seed: 1,
      rounds: 1,
      maxCommands: 4,
      runtimeRatio: 0,
      providerFaults: false,
      profiles: ["process"],
      concurrency: 1,
      triageReplays: 1,
      faultPool: ["killKernelDuringBuild"],
      version: { package: "0.9.0", node: "v22", gitCommit: "abc123", gitBranch: "main", gitDirty: false },
      environment: {},
    },
    coverage,
    failures: { rounds: 1, unique: 0, reproducible: 0, flaky: 0, falsePositive: 0, unverified: 0, product: 0, harness: 0 },
    clusters: [],
    underExplored: ["file-state：0 次真注入"],
    notes: [],
  };
  const markdown = renderCampaignReport(report);
  for (const heading of [
    "## 1. 跑了多少轮 / 多少状态组合",
    "## 2. 命中了哪些 action / fault / invariant",
    "## 3. 发现多少 failure，多少 unique",
    "## 4. 哪些可以稳定 replay",
    "## 5. shrink 后最小路径",
    "## 6. 高频 failure 集中在哪些边界",
    "## 7. 哪些区域探索不足",
    "## 复现信息",
  ]) {
    assert.ok(markdown.includes(heading), `report 缺 ${heading}`);
  }
  assert.ok(markdown.includes("campaign rerun"), "report 要给出重跑方式");
  assert.equal(coverage.faultsInjected.killKernelDuringBuild, 1);
  assert.equal(coverage.faultsInjectionFailed.partialStateWrite, 1, "注入失败要单独计数，不能混进 NotApplicable");
  assert.equal(coverage.faultsRecoveryFailed.killKernelDuringBuild, 1, "恢复失败也要单独计数");
  assert.equal(coverage.boundaries.process!.injected, 1);
  assert.ok(markdown.includes("### 每个 fault 的注入结果"), "report 要给每个 fault 的三态统计");
  assert.ok(markdown.includes("InjectionFailed"), "report 要看得见 InjectionFailed");
});

test("campaign report: 老 report.json 没有四态字段也要能渲染", () => {
  // 已经入库的 campaign 是旧 harness 写的，coverage 里没有 InjectionFailed /
  // RecoveryFailed 两个桶。渲染这些老数据不能崩：读回来要补成空桶。
  const dir = mkdtempSync(join(tmpdir(), "pi-cad-campaign-legacy-"));
  const manifest = {
    campaignId: "legacy",
    createdAt: "2026-09-22T00:00:00.000Z",
    mode: "short",
    seed: 1,
    rounds: 1,
    maxCommands: 4,
    runtimeRatio: 0,
    providerFaults: false,
    profiles: ["process"],
    concurrency: 1,
    triageReplays: 1,
    faultPool: ["killKernelDuringBuild"],
    version: { package: "0.9.0", node: "v22", gitCommit: "abc123", gitBranch: "main", gitDirty: false },
    environment: {},
  };
  const legacyCoverage = {
    rounds: 1,
    runtimeRounds: 0,
    oneShotRounds: 1,
    profiles: { process: 1 },
    actions: { startRun: 1 },
    faultsInjected: { killKernelDuringBuild: 1 },
    faultsNotApplicable: {},
    invariantsChecked: ["no-orphan-kernel"],
    boundaries: { process: { rounds: 1, injected: 1 }, "file-state": { rounds: 0, injected: 0 }, "provider-oauth": { rounds: 0, injected: 0 }, race: { rounds: 0, injected: 0 } },
    components: { kernel: 1 },
  };
  const legacyReport = {
    campaignId: "legacy",
    createdAt: "2026-09-22T00:00:00.000Z",
    manifest,
    coverage: legacyCoverage,
    failures: { rounds: 0, unique: 0, reproducible: 0, flaky: 0, falsePositive: 0, unverified: 0, product: 0, harness: 0 },
    clusters: [],
    underExplored: [],
    notes: [],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "report.json"), JSON.stringify(legacyReport));

  const loaded = loadCampaign(dir);
  assert.deepEqual(loaded.report?.coverage.faultsInjectionFailed, {}, "老 report 读回来要补空的 InjectionFailed 桶");
  assert.deepEqual(loaded.report?.coverage.faultsRecoveryFailed, {}, "老 report 读回来要补空的 RecoveryFailed 桶");
  const markdown = renderCampaignReport(loaded.report!);
  assert.ok(markdown.includes("### 每个 fault 的注入结果"), "老 report 也要渲染出每个 fault 的注入结果表");
  assert.ok(markdown.includes("| killKernelDuringBuild | 1 | 0 | 0 | 0 |"), "老 report 没有的两种状态显示 0，不虚构数据");
});

test("campaign: normalizeText 抹掉 pid / 端口 / hash", () => {
  assert.equal(
    normalizeText("kernel 1445491(owner=1445434) 在 0xdeadbeef 之后 1234ms 死"),
    "kernel #(owner=#) 在 # 之后 #ms 死",
  );
  assert.equal(
    normalizeText("2 个 kernel 的父控制面已经死了，进程还在：1(owner=2), 3(owner=4)"),
    "N 个 kernel 的父控制面已经死了，进程还在：#(owner=#), #(owner=#)",
  );
  assert.equal(
    normalizeText("run v7-1790022485343-1fcc3d90 绑了 0 个会话（无）"),
    "run v#-#-# 绑了 # 个会话（无）",
    "产品生成的真 id 每轮都不一样，不能算身份",
  );
  assert.equal(normalizeText("/tmp/reify-chaos-b8kVeQ/canonical/runs/v7-1790020333353-04333c50/state.json").startsWith("/tmp/#"), true);
});

test("campaign triage: 三类结论只由 replay 决定", () => {
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 2, seedPathReplayOk: true }), "reproducible");
  assert.equal(
    classifyFailureVerdict({ attempts: 2, reproductions: 2, seedPathReplayOk: false }),
    "flaky",
    "序列每次都中但 seed+path 没中同一 invariant，只能算偶发",
  );
  assert.equal(classifyFailureVerdict({ attempts: 3, reproductions: 2, seedPathReplayOk: true }), "flaky");
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 1, seedPathReplayOk: false }), "flaky");
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 0, seedPathReplayOk: true }), "flaky");
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 0, seedPathReplayOk: false }), "false-positive");
  // 只有「序列全中 + seed+path 也中」才配叫稳定复现；缺 seed+path 一律退回偶发。
  assert.equal(classifyFailureVerdict({ attempts: 1, reproductions: 1, seedPathReplayOk: false }), "flaky");
});

test("campaign triage: 序列 replay 全中但 seed+path 没中，shrink 成功也不能判稳定", async () => {
  // 预审点名的第二条：序列 replay 2/2 命中、后面的 shrink / enriched 也命中，
  // 但 seed+path 一次都没复现同一个 invariant —— 这不是 stable，必须仍是 flaky。
  const stability = await assessClusterStability(clusterWith(), {
    replays: 2,
    regressionDir: "/tmp/unused",
    deps: {
      replay: async (_file: string, options: { seed?: boolean } = {}) =>
        options.seed ? replayResult(false, "seed+path", "按 seed+path 没复现") : replayResult(true, "sequence"),
      run: async () => reproducedRun,
      load: () => artifact({ detail: "控制面死了 kernel 还在", sequence: [command("action", "startRun")] }),
    },
  });
  assert.equal(stability.verdict, "flaky", "seed+path 没复现，序列再稳也只能算偶发");
  assert.equal(stability.attempts, 3, "2 次序列 replay + 1 次 shrink 重跑");
  assert.equal(stability.reproductions, 3, "3 次都命中了");
  assert.equal(stability.seedPathReplayOk, false);
  assert.ok(stability.enriched, "shrink 命中了，最小证据还是要留");
});

test("campaign triage: triageCluster 在这条规则下仍把「序列+shrink 中、seed+path 不中」判 flaky", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-triage-"));
  const enrichedArtifact = join(dir, "enriched.json");
  writeFileSync(
    enrichedArtifact,
    JSON.stringify(artifact({ detail: "控制面死了 kernel 还在", sequence: [command("action", "startRun")] })),
    "utf8",
  );
  const result = await triageCluster(clusterWith(), {
    replays: 2,
    regressionDir: join(dir, "regressions"),
    quiet: true,
    deps: {
      replay: async (_file: string, options: { seed?: boolean } = {}) =>
        options.seed ? replayResult(false, "seed+path", "按 seed+path 没复现") : replayResult(true, "sequence"),
      run: async () => ({ ...reproducedRun, artifactPath: enrichedArtifact }),
      load: () => artifact({ detail: "控制面死了 kernel 还在", sequence: [command("action", "startRun")] }),
    },
  });
  assert.equal(result.verdict, "flaky", "最终结论由 triageCluster 给出，也必须遵守这条规则");
  assert.equal(result.triage.ruleVersion, 3, "结论要带当前规则版本");
  assert.equal(result.triage.attempts, 3);
  assert.equal(result.triage.reproductions, 3);
  assert.equal(result.triage.seedPathReplayOk, false);
  assert.equal(result.triage.shrinkOk, true, "shrink 命中了，最小复现仍要落盘");
});

test("campaign triage: shrink 单次成功不能把 flaky 提升成 reproducible", async () => {
  // 预审点名的场景：2 次按序列 replay 只中 1 次，seed+path 复现，
  // 后面的 shrink / enriched 重跑再成功一次 —— 旧实现会在最后无条件返回
  // reproducible，把真实偶发失败升级成稳定复现。
  let sequenceReplays = 0;
  const stability = await assessClusterStability(clusterWith(), {
    replays: 2,
    regressionDir: "/tmp/unused",
    deps: {
      replay: async (_file: string, options: { seed?: boolean } = {}) => {
        if (options.seed) return replayResult(true, "seed+path");
        sequenceReplays += 1;
        return sequenceReplays === 1
          ? replayResult(true, "sequence")
          : replayResult(false, "sequence", "序列跑完但没有复现失败");
      },
      run: async () => reproducedRun,
      load: () => artifact({ detail: "控制面死了 kernel 还在", sequence: [command("action", "startRun")] }),
    },
  });
  assert.equal(stability.verdict, "flaky", "2 次只中 1 次就是偶发，shrink 成功也不能改这个结论");
  assert.equal(stability.reproductions, 2, "1 次序列 replay + 1 次 shrink 重跑命中");
  assert.equal(stability.attempts, 3, "2 次序列 replay + 1 次 shrink 重跑都算数");
  assert.ok(stability.enriched, "shrink 重跑复现了，证据要留下来");
});

test("campaign triage: 每次都复现才算 stable", async () => {
  const stability = await assessClusterStability(clusterWith(), {
    replays: 2,
    regressionDir: "/tmp/unused",
    deps: {
      replay: async (_file: string, options: { seed?: boolean } = {}) => replayResult(true, options.seed ? "seed+path" : "sequence"),
      run: async () => reproducedRun,
      load: () => artifact({ detail: "控制面死了 kernel 还在", sequence: [command("action", "startRun")] }),
    },
  });
  assert.equal(stability.verdict, "reproducible");
  assert.equal(stability.reproductions, 3);
  assert.equal(stability.attempts, 3);
});

test("campaign triage: 一次都没复现算假阳性，不去 shrink", async () => {
  let ran = false;
  const stability = await assessClusterStability(clusterWith(), {
    replays: 2,
    regressionDir: "/tmp/unused",
    deps: {
      replay: async (_file: string, options: { seed?: boolean } = {}) =>
        options.seed ? replayResult(false, "seed+path", "没有 fast-check path") : replayResult(false, "sequence", "没复现"),
      run: async () => {
        ran = true;
        return reproducedRun;
      },
      load: () => artifact({ detail: "控制面死了 kernel 还在", sequence: [command("action", "startRun")] }),
    },
  });
  assert.equal(stability.verdict, "false-positive");
  assert.equal(ran, false, "假阳性没有可 shrink 的证据，不该再跑一轮真 shrink");
});
