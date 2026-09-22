import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCampaign } from "../chaos/campaign/campaign.ts";
import { aggregateCoverage } from "../chaos/campaign/coverage.ts";
import { buildRoundPlan, deriveRoundSeed } from "../chaos/campaign/plan.ts";
import { CAMPAIGN_PROFILES, NETWORK_PROVIDER_FAULTS, campaignFaultPool, profileFaultScope, resolveProfiles } from "../chaos/campaign/profiles.ts";
import { renderCampaignReport } from "../chaos/campaign/report.ts";
import { clusterFailures, failureSignature, normalizeText } from "../chaos/campaign/signature.ts";
import { assessClusterStability, classifyFailureVerdict } from "../chaos/campaign/triage.ts";
import type { CampaignReport, CampaignRound, FailureCluster } from "../chaos/campaign/types.ts";
import type { ReifyReplayResult, ReifyRunResult } from "../chaos/reify/runner.ts";
import { FAULT_BOUNDARIES } from "../chaos/reify/faults.ts";
import type { ReifyFailureArtifact } from "../chaos/reify/artifacts.ts";
import type { Command } from "../chaos/reify/model.ts";

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
      faultOutcomes: [],
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
  assert.equal(coverage.boundaries.process!.injected, 1);
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
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 2, seedPathReplayOk: false }), "reproducible");
  assert.equal(classifyFailureVerdict({ attempts: 3, reproductions: 2, seedPathReplayOk: true }), "flaky");
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 1, seedPathReplayOk: false }), "flaky");
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 0, seedPathReplayOk: true }), "flaky");
  assert.equal(classifyFailureVerdict({ attempts: 2, reproductions: 0, seedPathReplayOk: false }), "false-positive");
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
