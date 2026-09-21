import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadReifyArtifact } from "../reify/artifacts.ts";
import { reifyChaosRun, replayReifyArtifact } from "../reify/runner.ts";
import { commandShape } from "./signature.ts";
import type { FailureCluster, FailureVerdict, TriageResult } from "./types.ts";

export interface TriageOptions {
  /** How many times to replay the recorded sequence before judging it. */
  replays: number;
  /** Where to keep the verified minimal reproductions. */
  regressionDir: string;
  quiet?: boolean;
}

const gitCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return "unknown";
  }
};

/**
 * Decide what a unique failure really is by running it again, and keep the
 * shrunk minimal reproduction as the regression input.
 *
 * The round that first found a failure is only a claim. `reproducible` means
 * every replay hit it again, `false-positive` means none did, and `flaky`
 * means it hit sometimes — which is a real result about the system, not a
 * reason to throw the evidence away.
 */
export interface ClusterTriage {
  verdict: FailureVerdict;
  triage: TriageResult;
}

export async function triageCluster(cluster: FailureCluster, options: TriageOptions): Promise<ClusterTriage> {
  const notes: string[] = [];
  let reproductions = 0;
  let attempts = 0;
  let sequenceReplayOk = false;
  for (let index = 0; index < Math.max(1, options.replays); index += 1) {
    attempts += 1;
    const result = await replayReifyArtifact(cluster.representative, {});
    if (result.ok) {
      reproductions += 1;
      sequenceReplayOk = true;
    } else {
      notes.push(`第 ${index + 1} 次按序列 replay 没复现：${result.detail ?? ""}`);
    }
  }

  const seedReplay = await replayReifyArtifact(cluster.representative, { seed: true });
  const seedPathReplayOk = seedReplay.ok;
  if (!seedPathReplayOk) notes.push(`按 seed+path 没复现：${seedReplay.detail ?? ""}`);

  let verdict: FailureVerdict = "false-positive";
  if (reproductions === attempts && attempts > 0) verdict = "reproducible";
  else if (reproductions > 0 || seedPathReplayOk) verdict = "flaky";

  const triage: TriageResult = {
    attempts,
    reproductions,
    sequenceReplayOk,
    seedPathReplayOk,
    shrinkOk: false,
    originalLength: 0,
    shrunkLength: 0,
    numShrinks: 0,
    minimalSequence: [],
    notes,
  };

  if (verdict === "false-positive") return { verdict, triage };

  // Re-run the exact recorded path with shrinking on: that is what produces
  // the minimal sequence and the full component evidence for the artifact.
  const artifact = loadReifyArtifact(cluster.representative);
  const enriched = await reifyChaosRun({
    seed: artifact.seed,
    replayPath: artifact.replayPath,
    maxCommands: artifact.maxCommands,
    runtime: artifact.runtimeMode ?? false,
    faultScope: artifact.faultScope,
    quiet: true,
    save: true,
  });
  if (!enriched.failed || enriched.invariant !== cluster.invariant) {
    notes.push(`按 seed+path 重跑没有复现同一个 invariant（得到 ${enriched.invariant ?? "无"}）`);
    return { verdict: "flaky", triage };
  }

  mkdirSync(options.regressionDir, { recursive: true });
  const target = join(options.regressionDir, `${cluster.id}-${cluster.invariant}.json`);
  if (enriched.artifactPath) copyFileSync(enriched.artifactPath, target);
  const saved = loadReifyArtifact(target);
  triage.shrinkOk = true;
  triage.originalLength = enriched.originalLength;
  triage.shrunkLength = enriched.shrunkLength;
  triage.numShrinks = enriched.numShrinks;
  triage.minimalSequence = commandShape(saved.replaySequence?.length ? saved.replaySequence : saved.shrunkSequence);
  triage.enrichedArtifact = target;
  notes.push(`最小复现 ${triage.shrunkLength} 步（原始 ${triage.originalLength} 步，numShrinks=${triage.numShrinks}），commit=${gitCommit().slice(0, 12)}`);
  return { verdict: "reproducible", triage };
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
