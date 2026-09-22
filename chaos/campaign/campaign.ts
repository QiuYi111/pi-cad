import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReifyArtifact, type ReifyFailureArtifact } from "../reify/artifacts.ts";
import { FAULT_BOUNDARIES } from "../reify/faults.ts";
import { reifyInvariantDefinitions } from "../reify/invariants.ts";
import type { Command } from "../reify/model.ts";
import { reifyChaosRun } from "../reify/runner.ts";
import type { FaultOutcome } from "../reify/types.ts";
import { aggregateCoverage, componentsForCommand } from "./coverage.ts";
import { buildRoundPlan, type RoundPlanInput } from "./plan.ts";
import { campaignFaultPool, resolveProfiles, type CampaignProfile } from "./profiles.ts";
import { renderCampaignReport } from "./report.ts";
import { clusterFailures, type FailureInput } from "./signature.ts";
import { TRIAGE_RULES_VERSION, triageClusters } from "./triage.ts";
import type {
  CampaignManifest,
  CampaignMode,
  CampaignReport,
  CampaignRound,
  FailureCluster,
  FaultBoundary,
  PlannedRound,
} from "./types.ts";

export const CAMPAIGNS_DIR = fileURLToPath(new URL("../campaigns/", import.meta.url));
/** Repository root; `git` is always run from a directory that really exists. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface CampaignOptions {
  mode?: CampaignMode;
  rounds?: number;
  seed?: number;
  maxCommands?: number;
  profiles?: string[];
  /** 0 = one-shot authorities only, 1 = always the long-lived runtime. */
  runtimeRatio?: number;
  providerFaults?: boolean;
  concurrency?: number;
  triageReplays?: number;
  outDir?: string;
  campaignId?: string;
  skipTriage?: boolean;
  quiet?: boolean;
  parentCampaignId?: string;
}

const MODE_DEFAULTS: Record<CampaignMode, { rounds: number; maxCommands: number; profiles?: string[] }> = {
  // PR / CI short run: a few high-value paths, minutes not hours.
  short: { rounds: 6, maxCommands: 6 },
  // Nightly: hundreds of rounds across every boundary the fault space has.
  nightly: { rounds: 500, maxCommands: 8 },
  // Directed: only what `--profiles` names.
  targeted: { rounds: 50, maxCommands: 8 },
};

function gitInfo(): { commit: string; branch: string; dirty: boolean } {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { encoding: "utf8", cwd: REPO_ROOT }).trim();
    } catch {
      return "";
    }
  };
  return {
    commit: run(["rev-parse", "HEAD"]) || "unknown",
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown",
    // Tracked-only: a scratch file next to the checkout does not change the
    // code under test, and calling that "dirty" would make every manifest look
    // untrustworthy.
    dirty: run(["status", "--porcelain", "--untracked-files=no"]).length > 0,
  };
}

function packageVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function environmentSnapshot(): Record<string, string | null> {
  const keys = [
    "CHAOS_REIFY_PROVIDER_FAULTS",
    "CHAOS_REIFY_PROVIDER_PROBE",
    "CHAOS_REIFY_PROVIDER",
    "CHAOS_REIFY_MODEL",
    "CHAOS_REIFY_RECOVERY_BUDGET_MS",
    "CHAOS_REIFY_ORPHAN_GRACE_MS",
    "CHAOS_REIFY_PAUSE_MS",
    "CHAOS_REIFY_FINAL_SETTLE_MS",
    "CHAOS_REIFY_CPU_WORKERS",
    "PI_CAD_KERNEL",
  ];
  return Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
}

export function campaignTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export interface ResolvedCampaign {
  manifest: CampaignManifest;
  profiles: CampaignProfile[];
  plan: PlannedRound[];
  outDir: string;
  regressionDir: string;
}

export function resolveCampaign(options: CampaignOptions = {}): ResolvedCampaign {
  const mode = options.mode ?? "short";
  const defaults = MODE_DEFAULTS[mode];
  const explicitProfiles = options.profiles?.length ? options.profiles : defaults.profiles;
  if (mode === "targeted" && !explicitProfiles?.length) {
    throw new Error("targeted 模式必须给 --profiles（例如 kernel-lifecycle,runtime-recovery）");
  }
  const profiles = resolveProfiles(explicitProfiles);
  const providerFaults = options.providerFaults ?? process.env.CHAOS_REIFY_PROVIDER_FAULTS === "1";
  const pool = campaignFaultPool(providerFaults);
  const seed = options.seed ?? 7000;
  const maxCommands = options.maxCommands ?? defaults.maxCommands;
  const rounds = options.rounds ?? defaults.rounds;
  const runtimeRatio = options.runtimeRatio ?? 0.5;
  const campaignId = options.campaignId ?? `${campaignTimestamp()}-${mode}-${rounds}r`;
  const git = gitInfo();
  const manifest: CampaignManifest = {
    campaignId,
    createdAt: new Date().toISOString(),
    mode,
    seed,
    rounds,
    maxCommands,
    runtimeRatio,
    providerFaults,
    profiles: profiles.map((profile) => profile.name),
    concurrency: Math.max(1, options.concurrency ?? 1),
    triageReplays: Math.max(1, options.triageReplays ?? 2),
    faultPool: pool,
    version: {
      package: packageVersion(),
      node: process.version,
      gitCommit: git.commit,
      gitBranch: git.branch,
      gitDirty: git.dirty,
    },
    environment: environmentSnapshot(),
    ...(options.parentCampaignId ? { parentCampaignId: options.parentCampaignId } : {}),
  };
  const planInput: RoundPlanInput = { rounds, seed, maxCommands, profiles, faultPool: pool, runtimeRatio };
  return {
    manifest,
    profiles,
    plan: buildRoundPlan(planInput),
    outDir: options.outDir ?? join(CAMPAIGNS_DIR, campaignId),
    regressionDir: join(options.outDir ?? join(CAMPAIGNS_DIR, campaignId), "regressions"),
  };
}

/**
 * One real round, in its own session.
 *
 * Per-round sessions are what keep a killed runtime, a broken state file or a
 * leaked kernel from contaminating the next sample.
 */
async function runRound(planned: PlannedRound): Promise<{ round: CampaignRound; artifact?: ReifyFailureArtifact }> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let firstRound: { generated: Command[]; executed: Command[]; faultOutcomes: FaultOutcome[] } | undefined;
  let status: CampaignRound["status"] = "passed";
  let invariant: string | undefined;
  let detail: string | undefined;
  let artifactPath: string | undefined;
  let replayPath: string | undefined;
  let originalLength: number | undefined;
  let shrunkLength: number | undefined;
  let numShrinks: number | undefined;
  let effectiveSeed: number | undefined;
  let error: string | undefined;
  try {
    const result = await reifyChaosRun({
      numRuns: 1,
      seed: planned.seed,
      maxCommands: planned.maxCommands,
      runtime: planned.runtimeMode,
      faultScope: planned.faultScope ?? undefined,
      preparation: planned.preparation,
      quiet: true,
      // A campaign round is a sample: save the raw failure, skip the expensive
      // shrink and component probe. Triage does that for unique failures only.
      shrink: false,
      verify: false,
    });
    firstRound = result.firstRound;
    effectiveSeed = result.seed;
    if (result.failed) {
      status = "failed";
      invariant = result.invariant;
      detail = result.detail;
      artifactPath = result.artifactPath;
      replayPath = result.replayPath;
      originalLength = result.originalLength;
      shrunkLength = result.shrunkLength;
      numShrinks = result.numShrinks;
    }
  } catch (caught) {
    // A harness-level throw is not a clean pass: it gets its own status.
    status = "error";
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  const executed = firstRound?.executed ?? [];
  const faultOutcomes = firstRound?.faultOutcomes ?? [];
  const injected = faultOutcomes.filter((outcome) => outcome.phase === "inject" && outcome.status === "Injected");
  const notApplicable = faultOutcomes.filter((outcome) => outcome.phase === "inject" && outcome.status === "NotApplicable");
  const boundaries = new Set<FaultBoundary>();
  const components = new Set<string>();
  for (const command of executed) {
    for (const component of componentsForCommand(command.name)) components.add(component);
    if (command.kind !== "fault") continue;
    const boundary = FAULT_BOUNDARIES[command.name];
    if (boundary) boundaries.add(boundary);
  }
  const round: CampaignRound = {
    index: planned.index,
    seed: planned.seed,
    ...(effectiveSeed === undefined ? {} : { effectiveSeed }),
    profile: planned.profile,
    runtimeMode: planned.runtimeMode,
    maxCommands: planned.maxCommands,
    faultScope: planned.faultScope,
    preparation: planned.preparation,
    startedAt,
    durationMs: Date.now() - started,
    status,
    ...(invariant === undefined ? {} : { invariant }),
    ...(detail === undefined ? {} : { detail }),
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(replayPath === undefined ? {} : { replayPath }),
    ...(originalLength === undefined ? {} : { originalLength }),
    ...(shrunkLength === undefined ? {} : { shrunkLength }),
    ...(numShrinks === undefined ? {} : { numShrinks }),
    faultOutcomes,
    commands: executed.map((command) => `${command.kind}:${command.name}`),
    injectedFaults: [...new Set(injected.map((outcome) => outcome.name))],
    notApplicableFaults: [...new Set(notApplicable.map((outcome) => outcome.name))],
    boundariesHit: [...boundaries],
    componentsTouched: [...components],
    recoveries: faultOutcomes.filter((outcome) => outcome.phase === "recover" && outcome.status === "Recovered").length,
    ...(error === undefined ? {} : { error }),
  };
  if (!artifactPath) return { round };
  return { round, artifact: loadReifyArtifact(artifactPath) };
}

/** Keep the raw failure inside the campaign so the dataset is self-contained. */
function stashArtifact(outDir: string, round: CampaignRound, artifact: ReifyFailureArtifact): string {
  const dir = join(outDir, "artifacts");
  mkdirSync(dir, { recursive: true });
  const name = `round-${String(round.index).padStart(5, "0")}-${artifact.invariant.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`;
  const target = join(dir, name);
  copyFileSync(round.artifactPath!, target);
  return target;
}

export interface CampaignRunSummary {
  outDir: string;
  manifest: CampaignManifest;
  report: CampaignReport;
  clusters: FailureCluster[];
}

/**
 * Run a real campaign: many independent rounds across the boundary profiles,
 * one artifact per failure, then dedupe / triage / report.
 */
export async function runReifyCampaign(options: CampaignOptions = {}): Promise<CampaignRunSummary> {
  const providerFaults = options.providerFaults ?? process.env.CHAOS_REIFY_PROVIDER_FAULTS === "1";
  // The generator asks the process-wide flag whether the transport faults are
  // allowed to really open TLS; the manifest records the same decision.
  if (providerFaults) process.env.CHAOS_REIFY_PROVIDER_FAULTS = "1";
  else delete process.env.CHAOS_REIFY_PROVIDER_FAULTS;

  const resolved = resolveCampaign({ ...options, providerFaults });
  const { manifest, outDir, regressionDir, plan } = resolved;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const roundsFile = join(outDir, "rounds.jsonl");
  writeFileSync(roundsFile, "", "utf8");

  const rounds: CampaignRound[] = [];
  const failureInputs: FailureInput[] = [];
  let next = 0;
  const completed = { count: 0 };

  const writeStatus = (stage: string, latest: string, nextCheckpoint: string): void => {
    const status = {
      campaignId: manifest.campaignId,
      stage,
      updatedAt: new Date().toISOString(),
      completed: completed.count,
      total: plan.length,
      latest,
      nextCheckpoint,
      failed: rounds.filter((round) => round.status === "failed").length,
      errored: rounds.filter((round) => round.status === "error").length,
      version: manifest.version,
    };
    writeFileSync(join(outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= plan.length) return;
      const planned = plan[index]!;
      const outcome = await runRound(planned);
      rounds.push(outcome.round);
      if (outcome.artifact && outcome.round.artifactPath) {
        outcome.round.campaignArtifact = stashArtifact(outDir, outcome.round, outcome.artifact);
        failureInputs.push({
          roundIndex: outcome.round.index,
          seed: outcome.round.seed,
          artifactPath: outcome.round.artifactPath,
          commit: manifest.version.gitCommit === "unknown" ? null : manifest.version.gitCommit,
          runtimeMode: outcome.round.runtimeMode,
          artifact: outcome.artifact,
        });
      }
      completed.count += 1;
      if (!options.quiet) {
        const label = outcome.round.status === "failed" ? `失败 ${outcome.round.invariant}` : outcome.round.status;
        process.stdout.write(
          `[${completed.count}/${plan.length}] #${outcome.round.index} ${outcome.round.profile}` +
            `${outcome.round.runtimeMode ? " runtime" : " one-shot"} ${label} ${(outcome.round.durationMs / 1000).toFixed(1)}s\n`,
        );
      }
      appendFileSync(roundsFile, `${JSON.stringify(outcome.round)}\n`, "utf8");
      writeStatus(
        "rounds",
        `#${outcome.round.index} ${outcome.round.profile} ${outcome.round.status}${outcome.round.invariant ? ` ${outcome.round.invariant}` : ""}`,
        `${completed.count}/${plan.length} 轮后写 report`,
      );
    }
  };

  writeStatus("rounds", "campaign 开始", `跑完 ${plan.length} 轮后 dedupe / triage`);
  const workers = Array.from({ length: manifest.concurrency }, () => worker());
  await Promise.all(workers);

  // A deterministic order makes the report and the JSON diffable.
  rounds.sort((a, b) => a.index - b.index);
  writeFileSync(roundsFile, `${rounds.map((round) => JSON.stringify(round)).join("\n")}\n`, "utf8");

  let clusters = clusterFailures(failureInputs);
  if (!options.skipTriage && clusters.length) {
    writeStatus("triage", `${clusters.length} 个 unique failure 待 replay / shrink`, "triage 完成写 report");
    clusters = await triageClusters(clusters, {
      replays: manifest.triageReplays,
      regressionDir,
      quiet: options.quiet,
    });
  }
  writeFileSync(join(outDir, "clusters.json"), `${JSON.stringify(clusters, null, 2)}\n`, "utf8");

  const coverage = aggregateCoverage(
    rounds,
    reifyInvariantDefinitions.map((definition) => definition.name),
    resolved.profiles.map((profile) => profile.name),
  );
  const report = buildReport(manifest, coverage, clusters, rounds);
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "report.md"), renderCampaignReport(report), "utf8");
  writeStatus("done", `${clusters.length} 个 unique failure`, "人工看 report.md");

  return { outDir, manifest, report, clusters };
}

function buildReport(
  manifest: CampaignManifest,
  coverage: CampaignReport["coverage"],
  clusters: FailureCluster[],
  rounds: CampaignRound[],
): CampaignReport {
  const reproducible = clusters.filter((cluster) => cluster.verdict === "reproducible").length;
  const flaky = clusters.filter((cluster) => cluster.verdict === "flaky").length;
  const falsePositive = clusters.filter((cluster) => cluster.verdict === "false-positive").length;
  const unverified = clusters.filter((cluster) => cluster.verdict === "unverified").length;
  const underExplored: string[] = [];
  const totalRounds = Math.max(1, rounds.length);
  for (const [boundary, stats] of Object.entries(coverage.boundaries)) {
    if (stats.injected === 0) underExplored.push(`${boundary}：0 次真注入`);
    else if (stats.injected / totalRounds < 0.05) {
      underExplored.push(`${boundary}：只有 ${stats.injected} 次真注入（${((stats.injected / totalRounds) * 100).toFixed(1)}%）`);
    }
  }
  const notApplicableTotal = Object.values(coverage.faultsNotApplicable).reduce((sum, count) => sum + count, 0);
  if (notApplicableTotal > totalRounds) {
    underExplored.push(`fault 不适用 ${notApplicableTotal} 次，多半是前置条件不满足；提高对应 profile 权重或补 opt-in`);
  }
  const notes: string[] = [];
  if (manifest.version.gitDirty) notes.push("campaign 起点工作区不干净，结论要对着 gitCommit 看");
  if (coverage.roundsErrored) notes.push(`${coverage.roundsErrored} 轮是 harness 自己报错，已单独计，不算产品发现`);
  if (unverified) notes.push(`${unverified} 个 unique failure 没验成，看 triage notes`);
  const harnessClusters = clusters.filter((cluster) => cluster.nature === "harness");
  if (harnessClusters.length) {
    notes.push(
      `${harnessClusters.length} 个 unique failure 是 harness 侧（${harnessClusters.map((cluster) => cluster.id).join(", ")}）：` +
        "那是 campaign 自己的 fault 注入打错了，不是产品发现；修在 harness 里，回归用例进 tests/chaos-reify.test.ts。",
    );
  }
  return {
    campaignId: manifest.campaignId,
    createdAt: new Date().toISOString(),
    manifest,
    coverage,
    failures: {
      rounds: coverage.roundsFailed,
      unique: clusters.length,
      reproducible,
      flaky,
      falsePositive,
      unverified,
      product: clusters.filter((cluster) => cluster.nature === "product").length,
      harness: clusters.filter((cluster) => cluster.nature === "harness").length,
    },
    clusters,
    underExplored,
    notes,
  };
}

export interface LoadedCampaign {
  dir: string;
  manifest: CampaignManifest;
  rounds: CampaignRound[];
  clusters: FailureCluster[];
  report?: CampaignReport;
}

/**
 * Recompute clusters, triage and the report from the rounds that are already
 * on disk.
 *
 * 500 real rounds are expensive; a better dedupe rule or a sharper
 * product-vs-harness rule must not cost another 500 rounds. The raw rounds stay
 * exactly as they ran — only the analysis is redone, and the report says which
 * commit did it.
 */
export async function reclusterCampaign(
  dir: string,
  options: { triageReplays?: number; skipTriage?: boolean; quiet?: boolean; retriage?: boolean } = {},
): Promise<CampaignRunSummary> {
  const loaded = loadCampaign(dir);
  const failureInputs: FailureInput[] = [];
  for (const round of loaded.rounds) {
    if (round.status !== "failed" || !round.artifactPath) continue;
    try {
      failureInputs.push({
        roundIndex: round.index,
        seed: round.seed,
        artifactPath: round.artifactPath,
        commit: loaded.manifest.version.gitCommit === "unknown" ? null : loaded.manifest.version.gitCommit,
        runtimeMode: round.runtimeMode,
        artifact: loadReifyArtifact(round.artifactPath),
      });
    } catch (error) {
      if (!options.quiet) process.stdout.write(`round #${round.index} 的 artifact 读不了，跳过：${(error as Error).message}\n`);
    }
  }
  let clusters = clusterFailures(failureInputs);
  // A cluster whose signature did not change already has a verdict, so the
  // same real sequences do not have to be replayed again — but only when that
  // verdict came from the current triage rule. A rule change means the old
  // conclusion has to be recomputed, otherwise the report would keep an answer
  // the current code no longer stands behind.
  const previous = new Map(loaded.clusters.map((cluster) => [cluster.signature, cluster]));
  for (const cluster of clusters) {
    const old = previous.get(cluster.signature);
    if (!options.retriage && old?.triage && old.triage.ruleVersion === TRIAGE_RULES_VERSION) {
      cluster.triage = old.triage;
      cluster.verdict = old.verdict;
    }
  }
  const untriaged = clusters.filter((cluster) => cluster.verdict === "unverified");
  if (!options.skipTriage && untriaged.length) {
    await triageClusters(untriaged, {
      replays: options.triageReplays ?? loaded.manifest.triageReplays,
      regressionDir: join(dir, "regressions"),
      quiet: options.quiet,
    });
  }
  writeFileSync(join(dir, "clusters.json"), `${JSON.stringify(clusters, null, 2)}\n`, "utf8");
  const coverage = aggregateCoverage(
    loaded.rounds,
    reifyInvariantDefinitions.map((definition) => definition.name),
    loaded.manifest.profiles,
  );
  const report = buildReport(loaded.manifest, coverage, clusters, loaded.rounds);
  const postCommit = gitInfo().commit.slice(0, 12);
  report.notes.unshift(
    `本轮报告由 campaign recluster 在已落盘的轮次上重算：原始轮次跑在 ${loaded.manifest.version.gitCommit.slice(0, 12)}，` +
      `recluster / re-triage / report 用的是 ${postCommit}（triage 规则 v${TRIAGE_RULES_VERSION}）；` +
      "聚类口径见 chaos/campaign/signature.ts。",
  );
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "report.md"), renderCampaignReport(report), "utf8");
  return { outDir: dir, manifest: loaded.manifest, report, clusters };
}

/** Read a finished (or partial) campaign back off disk. */
export function loadCampaign(dir: string): LoadedCampaign {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as CampaignManifest;
  let rounds: CampaignRound[] = [];
  try {
    rounds = readFileSync(join(dir, "rounds.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CampaignRound);
  } catch {
    rounds = [];
  }
  let clusters: FailureCluster[] = [];
  try {
    clusters = JSON.parse(readFileSync(join(dir, "clusters.json"), "utf8")) as FailureCluster[];
  } catch {
    clusters = [];
  }
  let report: CampaignReport | undefined;
  try {
    report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as CampaignReport;
  } catch {
    report = undefined;
  }
  return { dir, manifest, rounds, clusters, report };
}
