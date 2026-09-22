import type { CampaignReport, FailureCluster } from "./types.ts";

const pct = (part: number, total: number): string => (total === 0 ? "0%" : `${((part / total) * 100).toFixed(1)}%`);

const table = (headers: string[], rows: string[][]): string[] => {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines;
};

const counts = (record: Record<string, number>, limit = 40): string =>
  Object.entries(record)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ") || "无";

function clusterRow(cluster: FailureCluster): string[] {
  return [
    cluster.id,
    cluster.invariant,
    cluster.boundaries.join("/"),
    cluster.nature,
    cluster.failingSteps.join(", "),
    String(cluster.occurrences),
    cluster.verdict,
    cluster.triage?.shrinkOk ? `${cluster.triage.shrunkLength} 步` : "-",
    cluster.reason.slice(0, 80),
  ];
}

/**
 * The inspectable campaign report. It answers the questions the issue asks, in
 * the order it asks them, and never turns "we did not reproduce it" into
 * "nothing happened".
 */
export function renderCampaignReport(report: CampaignReport): string {
  const { manifest, coverage, failures, clusters } = report;
  const total = Math.max(1, coverage.rounds);
  const lines: string[] = [];
  lines.push(`# Reify chaos campaign ${report.campaignId}`);
  lines.push("");
  lines.push(
    `跑完 ${coverage.rounds} 轮真 Reify：通过 ${coverage.roundsPassed}、失败 ${coverage.roundsFailed}、harness 报错 ${coverage.roundsErrored}。` +
      `失败里 unique ${failures.unique} 个：稳定 ${failures.reproducible}、偶发 ${failures.flaky}、假阳性 ${failures.falsePositive}、未验 ${failures.unverified}；` +
      `其中产品侧 ${failures.product} 个、harness 侧 ${failures.harness} 个。`,
  );
  lines.push("");
  lines.push(
    `起点 commit \`${manifest.version.gitCommit.slice(0, 12)}\`（${manifest.version.gitBranch}${manifest.version.gitDirty ? "，工作区脏" : ""}），` +
      `node ${manifest.version.node}，package ${manifest.version.package}。`,
  );
  lines.push("");

  lines.push("## 1. 跑了多少轮 / 多少状态组合");
  lines.push("");
  lines.push(
    `- 轮数 ${coverage.rounds}，独立 seed ${coverage.distinctSeeds}，真实状态观测 ≥${coverage.stateObservations} 次`,
  );
  lines.push(`- 常驻 runtime 轮 ${coverage.runtimeRounds}，一次性控制面轮 ${coverage.oneShotRounds}`);
  lines.push(`- generator：maxCommands=${manifest.maxCommands}，runtimeRatio=${manifest.runtimeRatio}，concurrency=${manifest.concurrency}`);
  lines.push(`- profile 轮数：${counts(coverage.profiles)}`);
  lines.push("");

  lines.push("## 2. 命中了哪些 action / fault / invariant");
  lines.push("");
  lines.push(`- action：${counts(coverage.actions)}`);
  lines.push(`- fault 真注入：${counts(coverage.faultsInjected)}`);
  lines.push(`- fault 不适用：${counts(coverage.faultsNotApplicable)}`);
  lines.push(`- invariant 每轮都查：${coverage.invariantsChecked.join(", ")}`);
  lines.push(`- 真实组件：${counts(coverage.components)}`);
  lines.push("");
  lines.push(...table(
    ["边界", "轮数", "真注入次数", "注入/轮"],
    Object.entries(coverage.boundaries).map(([boundary, stats]) => [
      boundary,
      String(stats.rounds),
      String(stats.injected),
      pct(stats.injected, total),
    ]),
  ));
  lines.push("");

  lines.push("## 3. 发现多少 failure，多少 unique");
  lines.push("");
  lines.push(
    `失败轮 ${failures.rounds} 轮 → unique ${failures.unique} 个。归并维度：坏掉哪个 invariant + 归一化后的失败原因` +
      `（pid、run id、临时目录、hash、出现次数、哪一步收场都不算身份）；每个 cluster 另外留下失败边界、出错步骤、` +
      `序列形状和日志签名。`,
  );
  lines.push("");
  lines.push(
    `产品侧 ${failures.product} 个是真产品发现；harness 侧 ${failures.harness} 个是 harness 自己的 fault 注入出问题（` +
      `比如故障之间互相踩到），要修 harness，不能当产品 bug 报。`,
  );
  lines.push("");
  lines.push(...table(
    ["cluster", "invariant", "边界", "哪一侧", "出错步骤", "次数", "结论", "最小复现", "原因"],
    clusters.map(clusterRow),
  ));
  lines.push("");

  lines.push("## 4. 哪些可以稳定 replay");
  lines.push("");
  if (!clusters.length) lines.push("- 没有 failure，没有 replay 结论");
  for (const cluster of clusters) {
    const triage = cluster.triage;
    lines.push(
      `- ${cluster.id} \`${cluster.invariant}\`：${cluster.verdict}` +
        (triage
          ? `（按序列 replay ${triage.reproductions}/${triage.attempts}，seed+path ${triage.seedPathReplayOk ? "复现" : "未复现"}）`
          : ""),
    );
    for (const note of triage?.notes ?? []) lines.push(`  - ${note}`);
    if (triage?.enrichedArtifact) lines.push(`  - artifact：${triage.enrichedArtifact}`);
  }
  lines.push("");

  lines.push("## 5. shrink 后最小路径");
  lines.push("");
  const shrunk = clusters.filter((cluster) => cluster.triage?.shrinkOk);
  if (!shrunk.length) lines.push("- 没有 shrink 成功的最小路径");
  for (const cluster of shrunk) {
    lines.push(`- ${cluster.id}（${cluster.triage!.originalLength} 步 → ${cluster.triage!.shrunkLength} 步）`);
    lines.push(`  \`${cluster.triage!.minimalSequence.join(" → ")}\``);
  }
  lines.push("");

  lines.push("## 6. 高频 failure 集中在哪些边界");
  lines.push("");
  const byBoundary = new Map<string, { clusters: number; occurrences: number }>();
  for (const cluster of clusters) {
    for (const boundary of cluster.boundaries) {
      const entry = byBoundary.get(boundary) ?? { clusters: 0, occurrences: 0 };
      entry.occurrences += cluster.occurrences;
      byBoundary.set(boundary, entry);
    }
    byBoundary.get(cluster.boundary)!.clusters += 1;
  }
  if (!byBoundary.size) lines.push("- 没有 failure");
  for (const [boundary, entry] of [...byBoundary.entries()].sort((a, b) => b[1].occurrences - a[1].occurrences)) {
    lines.push(`- ${boundary}：${entry.clusters} 个 unique，共 ${entry.occurrences} 次`);
  }
  lines.push("");

  lines.push("## 7. 哪些区域探索不足");
  lines.push("");
  if (!report.underExplored.length) lines.push("- 各边界都有真注入，暂不需要加权重");
  for (const note of report.underExplored) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## 每个 unique failure 的序列形状");
  lines.push("");
  for (const cluster of clusters) {
    lines.push(`- ${cluster.id} \`${cluster.invariant}\`（${cluster.occurrences} 次，seed ${cluster.seeds.slice(0, 5).join(", ")}${cluster.seeds.length > 5 ? "…" : ""}）`);
    for (const shape of cluster.shapes.slice(0, 5)) lines.push(`  - \`${shape.join(" → ")}\``);
    if (cluster.shapes.length > 5) lines.push(`  - …另外 ${cluster.shapes.length - 5} 种形状`);
  }
  lines.push("");

  lines.push("## 复现信息");
  lines.push("");
  lines.push(`- campaign id：\`${manifest.campaignId}\`，mode=${manifest.mode}`);
  lines.push(`- seed 基数：${manifest.seed}，轮数 ${manifest.rounds}，maxCommands ${manifest.maxCommands}`);
  lines.push(`- profiles：${manifest.profiles.join(", ")}`);
  lines.push(`- provider 传输故障：${manifest.providerFaults ? "开" : "关（opt-in）"}`);
  lines.push(`- fault 池大小：${manifest.faultPool.length}`);
  lines.push(`- 环境：${Object.entries(manifest.environment).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}`).join(", ") || "全默认"}`);
  lines.push("");
  lines.push("重跑同一条 campaign：");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run chaos:reify -- campaign rerun chaos/campaigns/${manifest.campaignId}`);
  lines.push("```");
  lines.push("");
  if (report.notes.length) {
    lines.push("## 备注");
    lines.push("");
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** One-screen console summary for a finished campaign. */
export function renderCampaignSummary(report: CampaignReport, outDir: string): string {
  const { coverage, failures } = report;
  return [
    `campaign ${report.campaignId} 完成：${coverage.rounds} 轮，失败 ${coverage.roundsFailed} 轮 / unique ${failures.unique} 个`,
    `  稳定 ${failures.reproducible}、偶发 ${failures.flaky}、假阳性 ${failures.falsePositive}、未验 ${failures.unverified}`,
    `  产品侧 ${failures.product}、harness 侧 ${failures.harness}`,
    `  边界：${Object.entries(coverage.boundaries).map(([boundary, stats]) => `${boundary}=${stats.injected}`).join(" ")}`,
    `  report：${outDir}/report.md`,
  ].join("\n");
}
