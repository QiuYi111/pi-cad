import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadReifyArtifact, type ReifyFailureArtifact } from "../reify/artifacts.ts";
import {
  reifyChaosRun,
  replayReifyArtifact,
  type ReifyReplayResult,
  type ReifyRunOptions,
  type ReifyRunResult,
} from "../reify/runner.ts";
import { commandShape } from "./signature.ts";
import type { FailureCluster, FailureVerdict, TriageResult } from "./types.ts";

/**
 * Bump this whenever the verdict rule changes. A cached verdict from an older
 * rule is not trusted by `campaign recluster`: re-running is supposed to apply
 * the new rule to the same raw rounds, not to parrot the old conclusion.
 */
export const TRIAGE_RULES_VERSION = 3;

/** The real replay / run / load, swappable so the verdict rule is unit-testable. */
export interface TriageDeps {
  replay: (file: string, options?: { seed?: boolean }) => Promise<ReifyReplayResult>;
  run: (options?: ReifyRunOptions) => Promise<ReifyRunResult>;
  load: (file: string) => ReifyFailureArtifact;
}

const DEFAULT_DEPS: TriageDeps = { replay: replayReifyArtifact, run: reifyChaosRun, load: loadReifyArtifact };

export interface TriageOptions {
  /** How many times to replay the recorded sequence before judging it. */
  replays: number;
  /** Where to keep the verified minimal reproductions. */
  regressionDir: string;
  quiet?: boolean;
  /** Test seam: override the real replay / run / load. */
  deps?: Partial<TriageDeps>;
}

const gitCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return "unknown";
  }
};

/**
 * How stably a failure reproduces, and nothing else.
 *
 * `reproducible` is reserved for "every sequence replay hit it again, and the
 * seed+path hit the same invariant too". A run where every sequence replay hit
 * but seed+path missed is a real `flaky`, not a stable failure. If nothing hit
 * anywhere it is a `false-positive`. Shrinking is deliberately not part of this
 * decision — it only minimizes the evidence afterwards.
 */
export function classifyFailureVerdict(input: {
  attempts: number;
  reproductions: number;
  seedPathReplayOk: boolean;
}): FailureVerdict {
  if (input.attempts > 0 && input.reproductions === input.attempts && input.seedPathReplayOk) return "reproducible";
  if (input.reproductions > 0 || input.seedPathReplayOk) return "flaky";
  return "false-positive";
}

/** What replaying a unique failure really showed about its stability. */
export interface ClusterStability {
  verdict: FailureVerdict;
  attempts: number;
  reproductions: number;
  sequenceReplayOk: boolean;
  seedPathReplayOk: boolean;
  notes: string[];
  /** The shrink-enabled rerun of the recorded path, only when it reproduced. */
  enriched?: ReifyRunResult;
}

export interface ClusterTriage {
  verdict: FailureVerdict;
  triage: TriageResult;
}

/**
 * Replay a unique failure until its stability is a fact, not a claim.
 *
 * The round that first found the failure is only a claim; every replay here is
 * real. The shrink-enabled rerun of the same path is counted as one more
 * replay, so it can lower the verdict but can never promote a `flaky` failure
 * to `reproducible`. A `reproducible` verdict also needs the seed+path replay
 * to hit the same invariant: sequence replays all hitting while seed+path
 * misses is a flaky failure, not a stable one.
 */
export async function assessClusterStability(cluster: FailureCluster, options: TriageOptions): Promise<ClusterStability> {
  const deps: TriageDeps = { ...DEFAULT_DEPS, ...options.deps };
  const notes: string[] = [];
  let reproductions = 0;
  let attempts = 0;
  let sequenceReplayOk = false;
  for (let index = 0; index < Math.max(1, options.replays); index += 1) {
    attempts += 1;
    const result = await deps.replay(cluster.representative, {});
    if (result.ok) {
      reproductions += 1;
      sequenceReplayOk = true;
    } else {
      notes.push(`第 ${index + 1} 次按序列 replay 没复现：${result.detail ?? ""}`);
    }
  }

  const seedReplay = await deps.replay(cluster.representative, { seed: true });
  const seedPathReplayOk = seedReplay.ok;
  if (!seedPathReplayOk) notes.push(`按 seed+path 没复现：${seedReplay.detail ?? ""}`);

  let verdict = classifyFailureVerdict({ attempts, reproductions, seedPathReplayOk });

  // A false positive never reproduced anywhere; there is nothing to minimize.
  if (verdict === "false-positive") {
    return { verdict, attempts, reproductions, sequenceReplayOk, seedPathReplayOk, notes };
  }

  // Re-run the exact recorded path with shrinking on: that is what produces
  // the minimal sequence and the full component evidence for the artifact. It
  // is also one more real replay of the same path, so it joins the tally — and
  // because a promotion would need every earlier replay to have hit too, this
  // cannot turn an already-`flaky` failure into `reproducible`.
  const artifact = deps.load(cluster.representative);
  const enriched = await deps.run({
    seed: artifact.seed,
    replayPath: artifact.replayPath,
    maxCommands: artifact.maxCommands,
    runtime: artifact.runtimeMode ?? false,
    faultScope: artifact.faultScope,
    quiet: true,
    save: true,
  });
  attempts += 1;
  if (enriched.failed && enriched.invariant === cluster.invariant) {
    reproductions += 1;
    verdict = classifyFailureVerdict({ attempts, reproductions, seedPathReplayOk });
    return { verdict, attempts, reproductions, sequenceReplayOk, seedPathReplayOk, notes, enriched };
  }
  notes.push(`按 seed+path 重跑没有复现同一个 invariant（得到 ${enriched.invariant ?? "无"}）`);
  verdict = classifyFailureVerdict({ attempts, reproductions, seedPathReplayOk });
  return { verdict, attempts, reproductions, sequenceReplayOk, seedPathReplayOk, notes };
}

/**
 * Settle a unique failure's verdict, then keep the shrunk minimal reproduction
 * as the regression input. Shrinking never touches the verdict.
 */
export async function triageCluster(cluster: FailureCluster, options: TriageOptions): Promise<ClusterTriage> {
  const deps: TriageDeps = { ...DEFAULT_DEPS, ...options.deps };
  const stability = await assessClusterStability(cluster, options);
  const triage: TriageResult = {
    ruleVersion: TRIAGE_RULES_VERSION,
    attempts: stability.attempts,
    reproductions: stability.reproductions,
    sequenceReplayOk: stability.sequenceReplayOk,
    seedPathReplayOk: stability.seedPathReplayOk,
    shrinkOk: false,
    originalLength: 0,
    shrunkLength: 0,
    numShrinks: 0,
    minimalSequence: [],
    notes: stability.notes,
  };
  const enriched = stability.enriched;
  if (!enriched) return { verdict: stability.verdict, triage };
  if (!enriched.artifactPath) {
    triage.notes.push("shrink 复现了，但没有落成 artifact 文件；这次不留最小序列");
    return { verdict: stability.verdict, triage };
  }

  mkdirSync(options.regressionDir, { recursive: true });
  const target = join(options.regressionDir, `${cluster.id}-${cluster.invariant}.json`);
  copyFileSync(enriched.artifactPath, target);
  const saved = deps.load(target);
  triage.shrinkOk = true;
  triage.originalLength = enriched.originalLength;
  triage.shrunkLength = enriched.shrunkLength;
  triage.numShrinks = enriched.numShrinks;
  triage.minimalSequence = commandShape(saved.replaySequence?.length ? saved.replaySequence : saved.shrunkSequence);
  triage.enrichedArtifact = target;
  triage.notes.push(
    `最小复现 ${triage.shrunkLength} 步（原始 ${triage.originalLength} 步，numShrinks=${triage.numShrinks}），commit=${gitCommit().slice(0, 12)}`,
  );
  if (stability.verdict === "flaky") {
    triage.notes.push("这是偶发失败的 shrink 结果，只作最小证据，不代表稳定复现");
  }
  return { verdict: stability.verdict, triage };
}

/** Triage every cluster, cheapest first so a long campaign still reports. */
export async function triageClusters(clusters: FailureCluster[], options: TriageOptions): Promise<FailureCluster[]> {
  const ordered = [...clusters].sort((a, b) => b.occurrences - a.occurrences);
  for (const cluster of ordered) {
    if (!options.quiet) {
      process.stdout.write(`triage ${cluster.id} ${cluster.invariant}（${cluster.occurrences} 次）...\n`);
    }
    try {
      const result = await triageCluster(cluster, options);
      cluster.verdict = result.verdict;
      cluster.triage = result.triage;
      if (!options.quiet) {
        process.stdout.write(
          `  ${cluster.verdict}：replay ${cluster.triage.reproductions}/${cluster.triage.attempts}` +
            `${cluster.triage.shrinkOk ? `，最小 ${cluster.triage.shrunkLength} 步` : ""}\n`,
        );
      }
    } catch (error) {
      cluster.verdict = "unverified";
      cluster.triage = {
        ruleVersion: TRIAGE_RULES_VERSION,
        attempts: 0,
        reproductions: 0,
        sequenceReplayOk: false,
        seedPathReplayOk: false,
        shrinkOk: false,
        originalLength: 0,
        shrunkLength: 0,
        numShrinks: 0,
        minimalSequence: [],
        notes: [`triage 自己失败：${(error as Error).message}`],
      };
    }
  }
  return clusters;
}
