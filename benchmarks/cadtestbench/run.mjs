#!/usr/bin/env node
/**
 * CADTestBench × Pi-CAD benchmark runner — ISOLATED edition (v2).
 *
 * One command per sample:
 *   CADTestBench prompt → Prime Agent + Pi-CAD sidecar → STEP → evaluator
 *   → archived manifest, with three-layer information isolation:
 *
 *   L1  VAULT    before the first agent starts, every ground-truth-bearing
 *                path on disk (frozen dataset, prompts archive, upstream
 *                baselines, ALL historical results incl. parity outputs,
 *                analysis docs, helper scripts) is tarred into
 *                results/.cache/orig-*.tar.gz and DELETED from the tree.
 *                Casual find/grep during a run cannot see task names, test
 *                code, or sibling solutions.
 *   L2  STAGING  each sample runs in a fresh results/.cache/staging/<sid>/
 *                containing only its prompt.txt. No neighbors exist —
 *                previous samples live only as tar archives.
 *   L3  AUDIT    every session is scanned for out-of-staging filesystem
 *                access before its manifest is finalized; anything touching
 *                .cache, ../, cadtest/parity/baseline names, or non-toolchain
 *                absolute paths is flagged (tier: hard/sibling) and excluded
 *                from clean PR. The summary refuses to present unaudited
 *                numbers.
 *
 * The evaluator's dataset is untarred to .cache/tmp only while no agent
 * process is alive (sequential runs), then removed.
 *
 * Recovery: `node run.mjs --restore-vault` untars everything back
 * (uses results/.cache/manifest.json — no key material involved).
 *
 * Usage:
 *   node run.mjs --set detailed-200 --label detailed200-clean
 *   node run.mjs --sample-ids 00000007 --label iso-probe
 *   node run.mjs --control-set clarity-controls --label clarity-controls
 *   node run.mjs --control-set clarity-controls --sample-ids 00001817 --label clarity-smoke
 *   node run.mjs --restore-vault
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateBenchmarkMetrics, failedEvaluationFromCadtests } from "./metrics.mjs";
import { legacyEvaluatorScale, normalizePhysicalUnitPrompt, physicalUnitIndex } from "./unit-normalization.mjs";

const HERE = resolve(process.env.PI_CAD_BENCH_DIR ?? fileURLToPath(new URL(".", import.meta.url)));
const REPO = process.env.PI_CAD_REPO ?? resolve(HERE, "..", "..");
const PRODUCTION_EXTENSIONS = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")).pi.extensions;
const PROVIDER = process.env.PI_CAD_PROVIDER ?? "openai-codex";
const MODEL = process.env.PI_CAD_MODEL ?? "gpt-5.6-luna";
const THINKING = process.env.PI_CAD_THINKING ?? "max";
const SCREEN_MODEL = process.env.PI_CAD_SCREEN_MODEL;
const SCREEN_THINKING = process.env.PI_CAD_SCREEN_THINKING ?? "low";
const TWO_STAGE = Boolean(SCREEN_MODEL);
const REVIEWER_PROVIDER = process.env.PI_CAD_REVIEWER_PROVIDER;
const REVIEWER_MODEL = process.env.PI_CAD_REVIEWER_MODEL;
const REVIEWER_THINKING = process.env.PI_CAD_REVIEWER_THINKING ?? THINKING;
if (Boolean(REVIEWER_PROVIDER) !== Boolean(REVIEWER_MODEL)) {
  throw new Error("PI_CAD_REVIEWER_PROVIDER and PI_CAD_REVIEWER_MODEL must be provided together");
}
const HEADLESS_AFTER_GRILLING = process.env.PI_CAD_HEADLESS_AFTER_GRILLING ?? "build";
if (!["build", "exit"].includes(HEADLESS_AFTER_GRILLING)) throw new Error("PI_CAD_HEADLESS_AFTER_GRILLING must be build or exit");
const WORKFLOW = process.env.PI_CAD_WORKFLOW
  ?? (HEADLESS_AFTER_GRILLING === "exit" ? "mechanical.benchmark-triage" : "mechanical.benchmark");
const NORMALIZE_PHYSICAL_UNITS = process.env.PI_CAD_NORMALIZE_PHYSICAL_UNITS !== "0";
const TIMEOUT_MS = Number(process.env.PI_CAD_TIMEOUT_MS ?? 1_800_000);
const RETRIES = Number(process.env.PI_CAD_RETRIES ?? 1);
if (!Number.isInteger(RETRIES) || RETRIES < 1) throw new Error("PI_CAD_RETRIES must be an integer of at least 1");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(REPO, ".pi-agent");
const AGENT_BIN = process.env.PI_CAD_AGENT_BIN ?? "prime-agent";
const PRIME = AGENT_BIN.includes("prime");
const BENCH_VENV = resolve(process.env.PI_CAD_BENCH_VENV ?? join(HERE, ".venv"));
const BENCH_PY = join(BENCH_VENV, "bin", "python");
const BENCH_CLI = join(BENCH_VENV, "bin", "cadtestbench");

const args = process.argv.slice(2);
const argValue = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const PARTITION = argValue("partition") ?? "detailed";
const LABEL = argValue("label") ?? "run";
const CACHE = join(HERE, "results", ".cache");

// ---------------------------------------------------------------- helpers

function sh(cmd, opts = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf-8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr ?? r.status}`);
  return r.stdout;
}

function tarCreate(tarPath, dir, name) {
  sh(["tar", "czf", tarPath, "-C", dir, name]);
}
function tarExtract(tarPath, dir) {
  mkdirSync(dir, { recursive: true });
  sh(["tar", "xzf", tarPath, "-C", dir]);
}

// Ground-truth-bearing paths, relative to HERE. Everything the agent must
// never see while a run is in flight. `results/*` is enumerated at runtime
// (timestamped run dirs) — the vault cache itself is excluded.
function sensitivePaths() {
  const fixed = [
    "data", "sets", "controls", "adjudication", "dataset-lock.json",
    join("external", "CADTestBench", "baselines"),
    ".hf-cache",
    "README.md", "retrospective-v0.1.md",
    "failure-mechanisms-and-improvements-v0.1.md",
    "failure-mechanisms-and-improvements-v0.2.md",
    "bootstrap.sh", "freeze-dataset.py", "extract-prompts.py", "select-sets.py",
    "parity.py", "classify.py", "compare.py", "report.py", "audit-leakage.py",
    "bridge.py", "paper-compare.py", "adjudicate.py", "adjudications.json",
  ];
  const out = fixed.map((p) => join(HERE, p)).filter((p) => existsSync(p));
  const resultsDir = join(HERE, "results");
  if (existsSync(resultsDir)) {
    for (const name of readdirSync(resultsDir)) {
      if (name === ".cache") continue;
      out.push(join(resultsDir, name));
    }
  }
  const extra = (process.env.PI_CAD_EXTRA_SENSITIVE_PATHS ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p))
    .filter((p) => existsSync(p));
  out.push(...extra);
  return out;
}

function vaultEverything() {
  mkdirSync(CACHE, { recursive: true });
  const manifest = [];
  for (const p of sensitivePaths()) {
    const parent = resolve(p, "..");
    const name = p.split("/").pop();
    const tar = join(CACHE, `orig-${manifest.length}.tar.gz`);
    tarCreate(tar, parent, name);
    rmSync(p, { recursive: true, force: true });
    const dest = relative(HERE, p);
    const absolute = dest === ".." || dest.startsWith("../");
    manifest.push({ tar: relative(HERE, tar), dest: absolute ? p : dest, absolute });
  }
  for (const d of ["staging", "archive", "tmp"]) mkdirSync(join(CACHE, d), { recursive: true });
  writeFileSync(join(CACHE, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function restoreVault() {
  const mPath = join(CACHE, "manifest.json");
  if (!existsSync(mPath)) { console.log("no vault to restore"); return; }
  // preserve any already-archived samples from an interrupted run
  const archiveDir = join(CACHE, "archive");
  if (existsSync(archiveDir)) {
    const recovered = join(HERE, "results", ".recovered");
    mkdirSync(recovered, { recursive: true });
    for (const f of readdirSync(archiveDir)) {
      copyFileSync(join(archiveDir, f), join(recovered, f));
    }
    console.log(`preserved ${readdirSync(archiveDir).length} archived sample(s) in results/.recovered/`);
  }
  for (const { tar, dest, absolute = false } of JSON.parse(readFileSync(mPath, "utf-8"))) {
    // Old manifests accidentally wrote HERE-relative paths with a leading
    // slash. New manifests mark genuinely absolute external paths explicitly.
    const normalizedDest = !absolute && dest.startsWith("/") ? dest.slice(1) : dest;
    const target = absolute ? normalizedDest : resolve(HERE, normalizedDest);
    tarExtract(vaultTarPath(tar), resolve(target, ".."));
    console.log(`restored ${dest}`);
  }
  rmSync(CACHE, { recursive: true, force: true });
  console.log("vault cache removed");
}

// ---------------------------------------------------------------- audit (L3)

const TOOLCHAIN_RX = /\/(src|node_modules|\.python|python|\.venv|ref|tests|scripts|assets|skills|recipes|build)\//;

function auditSession(sessionPath, ownStaging) {
  const flags = [];
  let tier = "clean";
  const rank = { clean: 0, toolchain: 1, sibling: 2, hard: 3 };
  const bump = (t) => { if (rank[t] > rank[tier]) tier = t; };
  // the sample's own staging dir is legitimate cwd material — never a flag
  if (!existsSync(sessionPath)) return { tier, flags };
  for (const line of readFileSync(sessionPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message ?? {};
    if (m.role !== "assistant") continue;
    for (const part of m.content ?? []) {
      const t = part.type ?? "";
      if (t !== "toolCall" && t !== "tool_call" && !t.endsWith("ToolCall")) continue;
      const name = part.name ?? "?";
      const argv = JSON.stringify(part.arguments ?? part.input ?? {});
      const paths = argv.match(/(?:\\?")(\/[^"\\]{4,}|\.?\.\/[^"\\]{2,})/g) ?? [];
      for (let raw of paths) {
        raw = raw.slice(1).replace(/\\\\/g, "\\");
        if (raw.startsWith("./") || raw === ".") continue;
        if (raw === ownStaging || raw.startsWith(ownStaging + "/")) continue;
        if (raw.includes("/.cache/") || raw.includes("/.cache")) {
          flags.push(`${name}: ${raw}`); bump("hard"); continue;
        }
        if (raw.startsWith("../")) {
          flags.push(`${name}: ${raw}`); bump("sibling"); continue;
        }
        if (/cadtest|parity|baselines|generated_models|dataset-lock|prompts\.detailed/.test(raw)) {
          flags.push(`${name}: ${raw}`); bump("hard"); continue;
        }
        if (raw.startsWith("/home/") || raw.startsWith("/")) {
          if (TOOLCHAIN_RX.test(raw)) { bump("toolchain"); }
          else {
            flags.push(`${name}: ${raw}`); bump("sibling");
          }
        }
      }
    }
  }
  return { tier, flags: flags.slice(0, 10) };
}

// ------------------------------------------------------------- agent runner

function piArgs(prompt, sessionId, model = MODEL, thinking = THINKING) {
  if (PRIME) {
    const reviewerArgs = REVIEWER_PROVIDER && REVIEWER_MODEL
      ? ["--reviewer-provider", REVIEWER_PROVIDER, "--reviewer-model", REVIEWER_MODEL, "--reviewer-thinking", REVIEWER_THINKING]
      : ["--reviewer-inherit-author", "--reviewer-thinking", REVIEWER_THINKING];
    return [
      "-p", "--provider", PROVIDER, "--model", model, "--thinking", thinking,
      ...reviewerArgs,
      "--", prompt,
    ];
  }
  return [
    "-p", "--provider", PROVIDER, "--model", model, "--thinking", thinking,
    "--no-skills", "--no-themes", "--session-id", sessionId,
    ...PRODUCTION_EXTENSIONS.flatMap((path) => ["-e", join(REPO, path.replace(/^\.\//, ""))]),
    prompt,
  ];
}

function runPi(workdir, prompt, sessionId, model = MODEL, thinking = THINKING) {
  return new Promise((res) => {
    const child = spawn(AGENT_BIN, piArgs(prompt, sessionId, model, thinking), {
      cwd: workdir,
      env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR,
             PI_CODING_AGENT_SESSION_DIR: join(workdir, ".sessions"),
             PRIME_AGENT_SESSION_DIR: join(workdir, ".prime-sessions"),
             PI_CAD_REPO: REPO,
             PI_CAD_HEADLESS: "1",
             PI_CAD_EXPERIENCE_ENABLED: "1",
             PI_CAD_EXPERIENCE_ROOT: experienceRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => { clearTimeout(timer); res({ code, signal, stdout, stderr }); });
  });
}

function sessionMetrics(workdir, sessionId) {
  const dir = join(workdir, PRIME ? ".prime-sessions" : ".sessions");
  if (!existsSync(dir)) return null;
  const files = sessionFiles(dir).filter((f) => PRIME || f.includes(sessionId));
  if (!files.length) return null;
  const u = { input: 0, cacheRead: 0, output: 0, total: 0, cost: 0 };
  let toolCalls = 0, candidateCommits = 0, errors = 0;
  for (const file of files) for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "message") continue;
    const m = e.message ?? {};
    if (m.role !== "assistant") continue;
    u.input += m.usage?.input ?? 0;
    u.cacheRead += m.usage?.cacheRead ?? 0;
    u.output += m.usage?.output ?? 0;
    u.total += m.usage?.totalTokens ?? 0;
    u.cost += m.usage?.cost?.total ?? 0;
    if (m.stopReason === "error" || m.errorMessage) errors += 1;
    for (const part of m.content ?? []) {
      const t = part.type ?? "";
      if (t === "toolCall" || t === "tool_call" || t.endsWith("ToolCall")) {
        toolCalls += 1;
        if (part.name === "cad_commit_candidate") candidateCommits += 1;
      }
      if (t === "toolResult" || t === "tool_result" || t.endsWith("ToolResult")) {
        if (part.isError || part.state === "output-error") errors += 1;
      }
    }
  }
  return { ...u, toolCalls, candidateCommits, errors };
}

function sessionFiles(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(dir);
  return files;
}

// ------------------------------------------------------- artifact resolution

function latestRun(workdir) {
  try {
    const runsDir = join(workdir, ".pi-cad", "runs");
    if (!existsSync(runsDir)) return null;
    for (const name of readdirSync(runsDir).sort().reverse()) {
      const sp = join(runsDir, name, "state.json");
      if (existsSync(sp)) return { runId: name, state: JSON.parse(readFileSync(sp, "utf-8")) };
    }
  } catch { /* fall through */ }
  return null;
}

function harnessState(workdir) {
  if (PRIME) {
    try {
      const projection = JSON.parse(readFileSync(join(workdir, ".pi-cad", "status.json"), "utf-8"));
      return {
        runId: projection.run?.id ?? null,
        workflowId: projection.run?.workflowId ?? null,
        terminal_phase: projection.run?.phase ?? null,
        terminal_status: projection.run?.status ?? null,
      };
    } catch { /* fall through */ }
  }
  const run = latestRun(workdir);
  if (!run) return { runId: null, workflowId: null, terminal_phase: null, terminal_status: null };
  const s = run.state;
  return {
    runId: s.runId ?? run.runId,
    workflowId: s.workflowId ?? null,
    terminal_phase: s.phase ?? null,
    terminal_status: s.status ?? null,
  };
}

function clarificationDebt(workdir) {
  const run = latestRun(workdir);
  if (!run) return [];
  try {
    const path = join(workdir, ".pi-cad", "runs", run.runId, "records", "requirements.json");
    const record = JSON.parse(readFileSync(path, "utf-8"));
    const stateDebt = Array.isArray(run.state.deferredClarifications)
      ? run.state.deferredClarifications
      : [];
    if (stateDebt.length) return stateDebt;
    return Array.isArray(record.deferredClarifications) ? record.deferredClarifications : [];
  } catch {
    return [];
  }
}

function resolveArtifact(workdir) {
  try {
    const project = JSON.parse(readFileSync(join(workdir, ".pi-cad", "v7-project", "state.json"), "utf-8"));
    const artifacts = Object.values(project.head?.artifacts ?? {});
    const artifact = artifacts.find((item) => item.id === "candidate:authoritative" || /authoritative.*candidate|candidate.*design/i.test(item.role)) ?? artifacts[0];
    const source = artifacts.find((item) => item.id === "candidate:source" || item.role === "candidate-source");
    if (artifact?.path) {
      return {
        path: resolve(workdir, artifact.path),
        source: source?.path ? resolve(workdir, source.path) : null,
        origin: "v7-project.head.artifacts",
      };
    }
  } catch { /* fall through */ }
  try {
    const project = JSON.parse(readFileSync(join(workdir, ".pi-cad", "project.json"), "utf-8"));
    if (project.head?.artifactPath) {
      return {
        path: resolve(workdir, project.head.artifactPath),
        source: project.head.sourcePath ? resolve(workdir, project.head.sourcePath) : null,
        origin: "project.head.artifactPath",
      };
    }
  } catch { /* fall through */ }
  const run = latestRun(workdir);
  if (run?.state?.artifacts) {
    const artifacts = Object.values(run.state.artifacts);
    const artifact = run.state.artifacts["candidate:authoritative"] ?? artifacts.find((item) => /authoritative.*candidate|candidate.*design/i.test(item.role)) ?? artifacts[0];
    const source = run.state.artifacts["candidate:source"] ?? artifacts.find((item) => item.role === "candidate-source");
    if (artifact?.path) {
      return {
        path: resolve(workdir, artifact.path),
        source: source?.path ? resolve(workdir, source.path) : null,
        origin: `runs.${run.runId}.artifacts`,
      };
    }
  }
  if (run?.state?.currentArtifactPath) {
    const ap = run.state.currentArtifactPath;
    const sp = run.state.currentSourcePath;
    return {
      path: ap.startsWith("/") ? ap : join(workdir, ".pi-cad", "runs", run.runId, ap),
      source: sp ? (sp.startsWith("/") ? sp : join(workdir, sp)) : null,
      origin: `runs.${run.runId}.currentArtifactPath`,
    };
  }
  if (PRIME) {
    const candidates = [];
    const visit = (directory, depth = 0) => {
      if (depth > 4) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path, depth + 1);
        else if (/\.(step|stp)$/i.test(entry.name)) candidates.push(path);
      }
    };
    visit(workdir);
    if (candidates.length) {
      candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      const path = candidates[0];
      const source = path.replace(/\.(step|stp)$/i, ".py");
      return { path, source: existsSync(source) ? source : null, origin: "workspace.latestStep" };
    }
  }
  return { path: null, source: null, origin: "NO_ARTIFACT" };
}

// ---------------------------------------------------------------- evaluator

const WRAPPER = `"""Pi-CAD -> CADTestBench bridge (auto-generated)."""
import math  # noqa: F401
from pathlib import Path

import cadquery as cq
import numpy as np  # noqa: F401


def create_cad():
    step_path = Path(__file__).with_name("final.step")
    return cq.importers.importStep(str(step_path))


final_result = create_cad()
`;

function evalSample(sampleId, evalRoot, dataDir) {
  const cmd = [
    BENCH_CLI, "evaluate", evalRoot,
    "--partition", PARTITION,
    "--dataset", dataDir,
    "--eval-root", join(evalRoot, "eval-out"),
    "--run-label", "pi-cad",
    "--sample-ids", sampleId,
  ];
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf-8",
    env: { ...process.env, HF_HOME: join(CACHE, "tmp", "hf"), HF_HUB_OFFLINE: "1" },
  });
  const runs = existsSync(join(evalRoot, "eval-out")) ? readdirSync(join(evalRoot, "eval-out")).sort() : [];
  if (!runs.length) return { error: `no eval-out; exit=${r.status}; out=${(r.stdout || "").slice(-250)}; err=${(r.stderr || "").slice(-250)}` };
  const dir = join(evalRoot, "eval-out", runs[runs.length - 1], "samples", sampleId);
  const sp = join(dir, "summary.json");
  if (!existsSync(sp)) return { error: `no summary in ${runs[runs.length - 1]}; exit=${r.status}; out=${(r.stdout || "").slice(-350)}; err=${(r.stderr || "").slice(-350)}` };
  const meta = JSON.parse(readFileSync(sp, "utf-8"))?.metrics?.cadtest?.metadata ?? {};
  const sm = meta.summary ?? {};
  return {
    passed: sm.passed ?? 0,
    total: sm.total_cadtests ?? 0,
    exactPass: Boolean(sm.total_cadtests) && sm.passed === sm.total_cadtests,
    modelCompileError: sm.model_compile_error ?? false,
    categories: sm.category_breakdown ?? {},
    rsGroups: meta.rs_groups ?? [],
    failures: (meta.cadtests ?? [])
      .filter((test) => test.status === "fail")
      .map((test) => ({
        requirement_id: test.requirement_id || "unknown",
        description: test.description || "",
        message: test.message || "",
      })),
    evaluationError: sm.evaluation_error ?? null,
  };
}

function recordBenchmarkExperience(staging, sampleId, evaluation, audit) {
  const markerPath = join(staging, ".pi-cad", "experience.json");
  if (!existsSync(markerPath)) return { status: "missing", reason: "completed Prime trajectory marker not found" };
  if (!evaluation || !Number.isInteger(evaluation.total) || evaluation.total <= 0) {
    return { status: "skipped", reason: "benchmark evaluator did not return a scorable result" };
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
  const groups = evaluation.rsGroups ?? [];
  const payload = {
    root: experienceRoot,
    identifier: { seq: marker.seq, sha: marker.sha },
    evaluation: {
      benchmark: "CADTestBench",
      partition: PARTITION,
      sample_id: sampleId,
      passed: evaluation.passed,
      total: evaluation.total,
      exact_pass: Boolean(evaluation.exactPass),
      rs_passed: groups.filter((group) => group.all_passed).length,
      rs_total: groups.length,
      integrity_status: audit.tier === "clean"
        ? "clean"
        : audit.tier === "toolchain" ? "toolchain" : "flagged",
      failures: evaluation.failures ?? [],
    },
  };
  const result = spawnSync(process.execPath, [join(REPO, "scripts", "pi-cad-experience.mjs")], {
    cwd: REPO,
    encoding: "utf-8",
    input: JSON.stringify(payload),
    env: { ...process.env, PI_CAD_EXPERIENCE_ROOT: experienceRoot },
  });
  if (result.status !== 0) {
    return { status: "error", reason: (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(-1000) };
  }
  const entry = JSON.parse(result.stdout);
  return {
    status: "recorded",
    seq: entry.seq,
    sha: entry.sha,
    benchmark_evaluation: entry.benchmark_evaluation,
  };
}

function archivePrimeExperienceFallback(staging, state) {
  const markerPath = join(staging, ".pi-cad", "experience.json");
  if (existsSync(markerPath)) return JSON.parse(readFileSync(markerPath, "utf-8"));
  const sessionPath = join(staging, "session.jsonl");
  if (!existsSync(sessionPath) || !state.runId) return null;
  const payload = {
    op: "finalize",
    root: experienceRoot,
    input: {
      runId: state.runId,
      workflow: state.workflowId || WORKFLOW,
      projectPath: staging,
      sessionPath,
      model: `${PROVIDER}/${MODEL}`,
      reasoning: THINKING,
      outcome: state.terminal_status === "done"
        ? "complete"
        : state.terminal_status === "waiting_user" && state.terminal_phase === "wait_for_user"
          ? "clarification_required"
          : "incomplete",
      outcomeReason: state.terminal_status === "done"
        ? "terminal workflow completed"
        : state.terminal_status === "waiting_user" && state.terminal_phase === "wait_for_user"
          ? "material requirements ambiguity requires user clarification before CAD begins"
          : `workflow ended ${state.terminal_status || "unknown"} in phase ${state.terminal_phase || "unknown"}`,
    },
  };
  const result = spawnSync(process.execPath, [join(REPO, "scripts", "pi-cad-experience.mjs")], {
    cwd: REPO,
    encoding: "utf-8",
    input: JSON.stringify(payload),
    env: { ...process.env, PI_CAD_EXPERIENCE_ROOT: experienceRoot },
  });
  if (result.status !== 0) return null;
  const entry = JSON.parse(result.stdout);
  const marker = { schema: 1, seq: entry.seq, sha: entry.sha, root: experienceRoot, runId: entry.run_id };
  mkdirSync(join(staging, ".pi-cad"), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

function failedEvaluation(sampleId, datasetDirectory, reason) {
  const script = [
    "import json,sys,pandas as pd",
    "p,sid=sys.argv[1:3]",
    "d=pd.read_parquet(p)",
    "cols=['cadtest_id','cadtest_description','cadtest_type','requirement_id','requirement_type','requirement_description']",
    "rows=d[d.sample_id.astype(str)==sid][cols].where(pd.notna(d),None).to_dict('records')",
    "print(json.dumps(rows))",
  ].join(";");
  const result = spawnSync("uv", [
    "run", "--no-project", "--python", BENCH_PY, "python", "-c", script,
    join(datasetDirectory, "cadtests", `${PARTITION}.parquet`), sampleId,
  ], { encoding: "utf-8" });
  if (result.status !== 0) {
    return { error: reason, scoringError: (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(-1000) };
  }
  return failedEvaluationFromCadtests(JSON.parse(result.stdout), reason);
}

// ---------------------------------------------------------------- main

// restore must run before anything that expects benchmark inputs on disk
if (args.includes("--restore-vault")) { restoreVault(); process.exit(0); }

function vaultTarPath(tar) {
  if (tar.startsWith("/results/")) return join(HERE, tar.slice(1));
  return tar.startsWith("/") ? tar : join(HERE, tar);
}

// 1. load benchmark inputs into memory BEFORE vaulting (on resume, pull
//    them out of the existing orig tars first)
const vaultActive = existsSync(join(CACHE, "manifest.json"));
const preloadDir = join(CACHE, "tmp-preload");
let baseDir = HERE;
if (vaultActive) {
  const vm = JSON.parse(readFileSync(join(CACHE, "manifest.json"), "utf-8"));
  for (const key of ["data", "sets", "controls"]) {
    const e = vm.find((x) => x.dest === key || x.dest.endsWith(`/${key}`));
    // Each vault tar already contains its top-level `data` or `sets`
    // directory. Extracting into preloadDir/key would create
    // tmp-preload/data/data and break interrupted-run resume.
    if (e) tarExtract(vaultTarPath(e.tar), preloadDir);
  }
  baseDir = preloadDir;
}
const SET = argValue("set");
const CONTROL_SET = argValue("control-set");
if (SET && CONTROL_SET) throw new Error("--set and --control-set are mutually exclusive");
const controlPath = CONTROL_SET
  ? [
      join(baseDir, "controls", `${CONTROL_SET}.json`),
      join(REPO, "benchmarks", "cadtestbench", "controls", `${CONTROL_SET}.json`),
    ].find((candidate) => existsSync(candidate))
  : null;
if (CONTROL_SET && !controlPath) throw new Error(`control set not found: ${CONTROL_SET}`);
const control = CONTROL_SET
  ? JSON.parse(readFileSync(controlPath, "utf-8"))
  : null;
const controlVariants = control?.variants ?? [];
if (control && (!Array.isArray(controlVariants) || !controlVariants.length)) {
  throw new Error(`control set ${CONTROL_SET} empty or missing variants`);
}
const IDS = SET
  ? JSON.parse(readFileSync(join(baseDir, "sets", `${SET}.json`), "utf-8"))
  : [];
const sampleIds = IDS.sample_ids ?? IDS;
if (SET && !sampleIds.length) throw new Error(`set ${SET} empty or missing`);
const requestedIds = (argValue("sample-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const idList = CONTROL_SET
  ? requestedIds.length ? requestedIds : controlVariants.map((variant) => variant.sample_id)
  : SET ? sampleIds : requestedIds;
if (!idList.length) throw new Error("no samples: pass --set or --sample-ids");
if (new Set(idList).size !== idList.length) throw new Error("duplicate sample ids are not allowed within one continual-experience run");
if (CONTROL_SET) {
  const available = new Set(controlVariants.map((variant) => variant.sample_id));
  for (const sid of idList) if (!available.has(sid)) throw new Error(`sample ${sid} is not in control set ${CONTROL_SET}`);
}

const promptsFile = JSON.parse(readFileSync(join(baseDir, "data", `prompts.${PARTITION}.json`), "utf-8"));
const prompts = new Map(promptsFile.map((e) => [e.sample_id, e.adapted]));
for (const variant of controlVariants) {
  if (!variant || typeof variant.sample_id !== "string" || typeof variant.prompt !== "string" || !variant.prompt.trim()) {
    throw new Error(`control set ${CONTROL_SET} contains an invalid variant`);
  }
  if (!prompts.has(variant.sample_id)) throw new Error(`control variant has no evaluator source sample: ${variant.sample_id}`);
  prompts.set(variant.sample_id, variant.prompt.trim());
}
const unitAdjudicationPath = [
  join(baseDir, "adjudication", "detailed-200-units.json"),
  join(REPO, "benchmarks", "cadtestbench", "adjudication", "detailed-200-units.json"),
].find((candidate) => existsSync(candidate));
const physicalUnits = NORMALIZE_PHYSICAL_UNITS && unitAdjudicationPath
  ? physicalUnitIndex(JSON.parse(readFileSync(unitAdjudicationPath, "utf-8")))
  : new Map();
for (const [sampleId, unitSpec] of physicalUnits) {
  if (prompts.has(sampleId)) prompts.set(sampleId, normalizePhysicalUnitPrompt(prompts.get(sampleId), unitSpec));
}
const ambiguityPath = [
  join(baseDir, "adjudication", "detailed-200-ambiguity.json"),
  join(REPO, "benchmarks", "cadtestbench", "adjudication", "detailed-200-ambiguity.json"),
].find((candidate) => existsSync(candidate));
const ambiguityDocument = ambiguityPath ? JSON.parse(readFileSync(ambiguityPath, "utf-8")) : null;
const ambiguityLabels = new Map((ambiguityDocument?.samples ?? []).map((sample) => [sample.sample_id, sample]));
for (const sid of idList) if (!prompts.has(sid)) throw new Error(`no adapted prompt for ${sid}`);
rmSync(preloadDir, { recursive: true, force: true });

// 2. vault (L1)
if (!vaultActive) vaultEverything();
else console.log("[iso] vault already active — resuming");

// 3. find the data tar for evaluator use
const vaultManifest = JSON.parse(readFileSync(join(CACHE, "manifest.json"), "utf-8"));
const dataEntry = vaultManifest.find((e) => e.dest.endsWith("/data") || e.dest === "data");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runName = `${stamp}_${LABEL}`;
const runRoot = join(HERE, "results", runName);
const experienceRoot = join(runRoot, "experience");
mkdirSync(experienceRoot, { recursive: true });
const gitHead = sh(["git", "-C", REPO, "rev-parse", "HEAD"]).trim();
const piVersion = sh([AGENT_BIN, "--version"]).trim();

const experiment = {
  benchmark: { name: "CADTestBench", partition: PARTITION,
    dataset: "frozen local parquet (vaulted during run; see dataset-lock.json)",
    upstreamRevision: "e29283cc61db7329039d95b429766a50bfd37f89",
    promptPolicy: CONTROL_SET
      ? `tracked clarity control ${CONTROL_SET}; append fixed task frame`
      : "strip code-generation prefix; append fixed task frame (extract-prompts.py)",
    ...(CONTROL_SET ? { controlSet: CONTROL_SET, controlDescription: control.description ?? "" } : {}) },
  agent: {
    provider: PROVIDER,
    model: MODEL,
    thinking: THINKING,
    ...(TWO_STAGE ? { screening: { provider: PROVIDER, model: SCREEN_MODEL, thinking: SCREEN_THINKING, workflow: "mechanical.benchmark-triage" } } : {}),
    reviewer: REVIEWER_PROVIDER && REVIEWER_MODEL
      ? { mode: "fixed", provider: REVIEWER_PROVIDER, model: REVIEWER_MODEL, thinking: REVIEWER_THINKING }
      : { mode: "inherit", thinking: REVIEWER_THINKING },
  },
  harness: { piCadCommit: gitHead, branch: sh(["git", "-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    piAgentVersion: piVersion,
    workflowPackage: WORKFLOW,
    runtime: PRIME ? "Prime Agent + authority sidecar" : "Pi",
    extensions: PRIME ? ["prime", "cad", "imagegen", "experience"] : [...PRODUCTION_EXTENSIONS],
    experience: {
      mode: "continual-within-run",
      rootPolicy: "fresh run-local library",
      crossSampleReuse: true,
      sameSampleHistory: false,
      evaluatorAuthority: "CADTestBench PR/RS",
    },
    isolation: "L1 vault + L2 per-sample staging + L3 per-session audit gate" },
  execution: {
    timeoutMs: TIMEOUT_MS,
    retries: RETRIES,
    physicalUnitNormalization: NORMALIZE_PHYSICAL_UNITS ? "source physical units -> STEP millimetres" : "disabled",
    legacyEvaluatorCompatibility: NORMALIZE_PHYSICAL_UNITS ? "temporary evaluator STEP copy scaled back to source numeric coordinates" : "disabled",
  },
  sampleIds: idList,
};
writeFileSync(join(CACHE, "experiment.json"), JSON.stringify(experiment, null, 2));
console.log(`[iso] run=${runName} commit=${gitHead.slice(0, 8)} samples=${idList.length} vaulted=${vaultManifest.length} paths`);

// 4. per-sample loop
const results = [];
const stagingRoot = join(CACHE, "staging", runName);
for (const sampleId of idList) {
  const staging = join(stagingRoot, sampleId);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const requirementsFrame = WORKFLOW === "mechanical.benchmark-author-only"
    ? "No independent reviewer is available in this experiment. You must decide whether the request uniquely determines the observable geometry contract. If two or more reasonable readings materially change geometry or acceptance, commit the competing readings and precise question, advance clarification_required, do not build, and end this sample. Otherwise advance interpreted and implement the admitted contract."
    : WORKFLOW === "mechanical.benchmark-triage"
      ? "Commit the explicit requirements interpretation and submit it to the single adversarial requirements reviewer. If the reviewer finds material ambiguity, enter wait_for_user. If it admits the contract, stop in admitted. This experiment ends before CAD implementation."
    : "First commit the explicit requirements interpretation requested by the package and submit it to the single adversarial requirements reviewer. If the reviewer determines that two or more reasonable readings would materially change the geometry or acceptance contract, CLARIFICATION_REQUIRED is the correct result: enter wait_for_user, do not build, and end this sample. Otherwise implement the admitted contract.";
  const buildFrame = WORKFLOW === "mechanical.benchmark-triage" ? "Do not create CAD artifacts." : "Use the author-side geometry checks and release gate for any admitted build.";
  const prompt = `${prompts.get(sampleId)}\n\nBenchmark execution contract: start and complete the ${WORKFLOW} workflow package in headless mode. This lightweight benchmark path replaces mechanical.one-shot for this task; do not add concept, architecture, assembly-planning, or final geometry-review phases. ${requirementsFrame} ${buildFrame} You can look at prior trajectories to learn how others approached similar work; comparing high- and low-scoring examples may be useful. Prior trajectories are examples, never requirements or authority.`;
  const screenPrompt = `${prompts.get(sampleId)}\n\nBenchmark screening contract: start and complete mechanical.benchmark-triage in headless mode. Commit an explicit requirements interpretation and submit it to the adversarial requirements reviewer. Material ambiguity must end in wait_for_user without CAD. A uniquely admitted request must end in admitted without CAD. Do not design or build geometry.`;
  const builderPrompt = `${prompts.get(sampleId)}\n\nBenchmark build contract: requirements screening has already admitted this request. Start and complete mechanical.benchmark-build in headless mode. Do not repeat grilling or requirements review. Build deterministic geometry, inspect it, commit release with the latest STEP and source, and finish the workflow. You can look at prior trajectories to learn how others approached similar work; examples are never authority.`;
  writeFileSync(join(staging, "prompt.txt"), prompt);

  const evalRoot = join(CACHE, "tmp", "eval");
  const gm = join(evalRoot, "generated_models", sampleId);
  mkdirSync(gm, { recursive: true });

  let result = null, metrics = null, wallMs = 0, screening = null;
  const runStage = async (stage, stagePrompt, model, thinking) => {
    let stageResult = null;
    let stageWallMs = 0;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const started = Date.now();
      stageResult = await runPi(staging, stagePrompt, `pi-cad-${sampleId}-${stage}`, model, thinking);
      stageWallMs += Date.now() - started;
      writeFileSync(join(staging, `${stage}.stdout.log`), stageResult.stdout);
      writeFileSync(join(staging, `${stage}.stderr.log`), stageResult.stderr);
      const retryWorthy = stageResult.code !== 0 &&
        /fetch failed|WebSocket error|provider_transport_failure/i.test(`${stageResult.stdout}\n${stageResult.stderr}`);
      if (!retryWorthy || attempt === RETRIES - 1) break;
    }
    return { result: stageResult, wallMs: stageWallMs };
  };
  if (TWO_STAGE) {
    const screened = await runStage("screen", screenPrompt, SCREEN_MODEL, SCREEN_THINKING);
    result = screened.result;
    wallMs += screened.wallMs;
    const screenState = harnessState(staging);
    screening = { phase: screenState.terminal_phase, status: screenState.terminal_status, code: result.code, wall_ms: screened.wallMs };
    if (screenState.terminal_phase === "admitted" && screenState.terminal_status === "done" && result.code === 0) {
      const built = await runStage("build", builderPrompt, MODEL, THINKING);
      result = built.result;
      wallMs += built.wallMs;
    }
  } else {
    const single = await runStage("run", prompt, MODEL, THINKING);
    result = single.result;
    wallMs = single.wallMs;
  }
  metrics = sessionMetrics(staging, `pi-cad-${sampleId}`);
  writeFileSync(join(staging, "stdout.log"), result.stdout);
  writeFileSync(join(staging, "stderr.log"), result.stderr);
  writeFileSync(join(staging, "run.json"),
    JSON.stringify({ sampleId, wallMs, code: result.code, signal: result.signal, screening }, null, 2));
    const sessDir = join(staging, PRIME ? ".prime-sessions" : ".sessions");
    if (existsSync(sessDir)) {
      const sessions = sessionFiles(sessDir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (sessions.length) copyFileSync(sessions[0], join(staging, "session.jsonl"));
    }
    if (existsSync(join(staging, ".pi-cad"))) {
      sh(["bash", "-c", `cp -r ${JSON.stringify(join(staging, ".pi-cad"))} ${JSON.stringify(join(staging, "pi-cad"))}`]);
    }

  const hs = harnessState(staging);
  const clarificationRequired = hs.terminal_status === "waiting_user" && hs.terminal_phase === "wait_for_user";
  const triageAdmitted = WORKFLOW === "mechanical.benchmark-triage" && hs.terminal_status === "done" && hs.terminal_phase === "admitted";

  // artifact + bridge
  const art = clarificationRequired || triageAdmitted
    ? { path: null, source: null, origin: clarificationRequired ? "CLARIFICATION_REQUIRED" : "REQUIREMENTS_ADMITTED" }
    : resolveArtifact(staging);
  let evaluation = null;
  if (art.path && existsSync(art.path)) {
    const gen = join(staging, "generated");
    mkdirSync(gen, { recursive: true });
    copyFileSync(art.path, join(gen, "final.step"));
    const unitSpec = physicalUnits.get(sampleId);
    if (unitSpec) {
      sh([BENCH_PY, join(REPO, "benchmarks", "cadtestbench", "scale-step.py"), art.path, join(gm, "final.step"), String(legacyEvaluatorScale(unitSpec))]);
    } else {
      copyFileSync(art.path, join(gm, "final.step"));
    }
    if (art.source && existsSync(art.source)) copyFileSync(art.source, join(gen, "source.py"));
    writeFileSync(join(gm, "gpt_generated.py"), WRAPPER);
  }

  // Requirements-only outcomes are accepted and intentionally unscored.
  if (clarificationRequired) {
    evaluation = {
      status: "clarification_required",
      scorable: false,
      passed: 0,
      total: 0,
      exactPass: false,
      categories: {},
      rsGroups: [],
      failures: [],
      evaluationError: null,
    };
  } else if (triageAdmitted) {
    evaluation = {
      status: "admitted",
      scorable: false,
      passed: 0,
      total: 0,
      exactPass: false,
      categories: {},
      rsGroups: [],
      failures: [],
      evaluationError: null,
    };
  } else if (WORKFLOW === "mechanical.benchmark-triage") {
    evaluation = {
      status: "incomplete",
      scorable: false,
      passed: 0,
      total: 0,
      exactPass: false,
      categories: {},
      rsGroups: [],
      failures: [],
      evaluationError: "requirements triage did not reach an authoritative outcome",
    };
  } else {
    // Untar dataset only while no agent is alive (L1).
    const dataTmp = join(CACHE, "tmp", "data");
    if (dataEntry) tarExtract(vaultTarPath(dataEntry.tar), dataTmp);
    const datasetDirectory = join(dataTmp, "data", "hf");
    if (existsSync(join(gm, "gpt_generated.py"))) {
      evaluation = evalSample(sampleId, evalRoot, datasetDirectory);
    // archive evaluator bundle into staging
    const ct = join(staging, "cadtest");
    mkdirSync(ct, { recursive: true });
    const runs2 = existsSync(join(evalRoot, "eval-out")) ? readdirSync(join(evalRoot, "eval-out")).sort() : [];
    if (runs2.length) {
      const d = join(evalRoot, "eval-out", runs2[runs2.length - 1], "samples", sampleId);
      for (const f of ["summary.json", "generated.stl", "code_with_cadtests.py"]) {
        if (existsSync(join(d, f))) copyFileSync(join(d, f), join(ct, f));
      }
    }
    } else {
      evaluation = failedEvaluation(
        sampleId,
        datasetDirectory,
        art.origin === "NO_ARTIFACT" ? "NO_ARTIFACT" : "artifact missing on disk",
      );
    }
    rmSync(join(CACHE, "tmp"), { recursive: true, force: true });
  }

  // audit gate (L3)
  const audit = auditSession(join(staging, "session.jsonl"), staging);
  if (PRIME) archivePrimeExperienceFallback(staging, hs);
  const experience = PRIME
    ? recordBenchmarkExperience(staging, sampleId, evaluation, audit)
    : { status: "disabled", reason: "legacy Pi runtime" };

  const manifest = {
    sample_id: sampleId,
    benchmark: experiment.benchmark, agent: experiment.agent,
    harness: { ...experiment.harness, terminal_phase: null, terminal_status: null, artifact_origin: art.origin },
    evaluation,
    unit_normalization: physicalUnits.has(sampleId) ? {
      applied: true,
      source_unit: physicalUnits.get(sampleId).source_unit,
      canonical_step_unit: "mm",
      scale_to_mm: physicalUnits.get(sampleId).scale_to_mm,
      evaluator_compatibility_scale: legacyEvaluatorScale(physicalUnits.get(sampleId)),
    } : { applied: false },
    adjudication: ambiguityLabels.has(sampleId) ? {
      ambiguity: ambiguityLabels.get(sampleId).label,
      categories: ambiguityLabels.get(sampleId).categories ?? [],
      confidence: ambiguityLabels.get(sampleId).confidence ?? null,
    } : null,
    integrity: audit, experience,
    usage: metrics ? {
      input_tokens: metrics.input, cached_input_tokens: metrics.cacheRead,
      output_tokens: metrics.output, total_tokens: metrics.total,
      cost_usd: Number((metrics.cost ?? 0).toFixed(6)) } : null,
    execution: metrics ? {
      tool_calls: metrics.toolCalls, candidate_commits: metrics.candidateCommits,
      errors: metrics.errors, wall_ms: wallMs } : null,
    exit_code: result.code, exit_signal: result.signal,
    ...(screening ? { screening } : {}),
  };
  manifest.workflow = {
    outcome: hs.terminal_status === "done"
      ? triageAdmitted ? "admitted" : "done"
      : hs.terminal_status === "blocked_user"
        ? "blocked_user"
        : hs.terminal_status === "blocked_external"
        ? "blocked_external"
          : hs.terminal_status === "budget_exhausted"
            ? "budget_exhausted"
          : hs.terminal_status === "waiting_user" && hs.terminal_phase === "wait_for_user"
            ? "clarification_required"
            : "incomplete",
    interaction_mode: "headless",
  };
  manifest.requirements = { deferred_clarifications: clarificationDebt(staging) };
  manifest.harness.terminal_phase = hs.terminal_phase;
  manifest.harness.terminal_status = hs.terminal_status;
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  // archive sample, destroy staging (L2)
  tarCreate(join(CACHE, "archive", `${sampleId}.tar.gz`), stagingRoot, sampleId);
  rmSync(staging, { recursive: true, force: true });

  results.push(manifest);
  const ev = evaluation ?? {};
  console.log(
    `[${sampleId}] exit=${result.code} phase=${hs.terminal_phase ?? "-"} ` +
    `cadtests=${ev.passed ?? "-"}/${ev.total ?? "-"} exact=${ev.exactPass ?? "-"} ` +
    `clarifications=${manifest.requirements.deferred_clarifications.length} ` +
    `audit=${audit.tier} tokens=${metrics?.total ?? "-"} wall=${Math.round(wallMs / 1000)}s`,
  );
}

// 5. finalize: lay archives out, restore vault, write summaries
mkdirSync(join(runRoot, "samples"), { recursive: true });
copyFileSync(join(CACHE, "experiment.json"), join(runRoot, "experiment.json"));
for (const sid of idList) {
  tarExtract(join(CACHE, "archive", `${sid}.tar.gz`), join(runRoot, "samples"));
}
writeFileSync(join(runRoot, "raw-manifests.json"), JSON.stringify(results, null, 2));

const clean = results.filter((r) => r.integrity.tier === "clean" || r.integrity.tier === "toolchain");
const sum = (f) => clean.reduce((a, m) => a + (Number(f(m)) || 0), 0);
const nAll = results.length;
const observedMetrics = aggregateBenchmarkMetrics(results);
const cleanMetrics = aggregateBenchmarkMetrics(clean);
const ambiguityBreakdown = (rows) => Object.fromEntries(["ambiguous", "borderline", "clear"].map((label) => {
  const selected = rows.filter((row) => row.adjudication?.ambiguity === label);
  return [label, {
    samples: selected.length,
    clarification_required: selected.filter((row) => row.workflow.outcome === "clarification_required").length,
    admitted: selected.filter((row) => row.workflow.outcome === "admitted").length,
    done: selected.filter((row) => row.workflow.outcome === "done").length,
    incomplete: selected.filter((row) => row.workflow.outcome === "incomplete").length,
  }];
}));
const summary = {
  runRoot, runName, harness: experiment.harness,
  integrity: {
    audited: nAll,
    clean_or_toolchain: clean.length,
    flagged: results.filter((r) => r.integrity.tier === "sibling" || r.integrity.tier === "hard")
      .map((r) => ({ sample_id: r.sample_id, tier: r.integrity.tier, flags: r.integrity.flags })),
  },
  observed: {
    ...observedMetrics,
    done: results.filter((r) => r.harness.terminal_phase === "done").length,
    admitted: results.filter((r) => r.workflow.outcome === "admitted").length,
    clarification_required: results.filter((r) => r.workflow.outcome === "clarification_required").length,
    cost_usd: Number(results.reduce((a, m) => a + (m.usage?.cost_usd ?? 0), 0).toFixed(4)),
    ambiguity: ambiguityBreakdown(results),
  },
  clean: {
    ...cleanMetrics,
    done: clean.filter((r) => r.harness.terminal_phase === "done").length,
    admitted: clean.filter((r) => r.workflow.outcome === "admitted").length,
    clarification_required: clean.filter((r) => r.workflow.outcome === "clarification_required").length,
    cost_usd: Number(clean.reduce((a, m) => a + (m.usage?.cost_usd ?? 0), 0).toFixed(4)),
    tokens: sum((m) => m.usage?.total_tokens ?? 0),
    ambiguity: ambiguityBreakdown(clean),
  },
};
writeFileSync(join(runRoot, "summary.json"), JSON.stringify(summary, null, 2));

restoreVault();
console.log("[iso] vault restored — ground truth back on disk");
console.log(JSON.stringify(summary, null, 2));
