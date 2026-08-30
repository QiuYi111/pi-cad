#!/usr/bin/env node
/**
 * CADTestBench × Pi-CAD benchmark runner — ISOLATED edition (v2).
 *
 * One command per sample:
 *   CADTestBench prompt → Pi-CAD harness (pi -p) → STEP → bridge → evaluator
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
 *   node run.mjs --restore-vault
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = process.env.PI_CAD_REPO ?? resolve(HERE, "..", "..");
const PROVIDER = process.env.PI_CAD_PROVIDER ?? "openai-codex";
const MODEL = process.env.PI_CAD_MODEL ?? "gpt-5.6-luna";
const THINKING = process.env.PI_CAD_THINKING ?? "max";
const TIMEOUT_MS = Number(process.env.PI_CAD_TIMEOUT_MS ?? 1_800_000);
const RETRIES = Number(process.env.PI_CAD_RETRIES ?? 1);
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(REPO, ".pi-agent");
const AGENT_COMMAND = process.env.PI_CAD_AGENT_COMMAND ?? "prime-agent";
const BENCH_PY = join(HERE, ".venv", "bin", "python");
const BENCH_CLI = join(HERE, ".venv", "bin", "cadtestbench");

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
    "data", "sets", "dataset-lock.json",
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
    manifest.push({ tar: tar.replace(HERE, ""), dest: p.replace(HERE, "") });
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
  for (const { tar, dest } of JSON.parse(readFileSync(mPath, "utf-8"))) {
    // path.resolve(HERE, dest, "..") handles both relative and absolute dests
    // (join(HERE, absolute) would concatenate into a doubled path)
    tarExtract(vaultTarPath(tar), resolve(HERE, dest, ".."));
    console.log(`restored ${dest}`);
  }
  rmSync(CACHE, { recursive: true, force: true });
  console.log("vault cache removed");
}

// ---------------------------------------------------------------- audit (L3)

const TOOLCHAIN_RX = /\/(src|skills|node_modules|\.python|python|\.venv|ref|tests|scripts|assets|build)\//;

function auditSession(sessionPath, sid) {
  const flags = [];
  let tier = "clean";
  const rank = { clean: 0, toolchain: 1, sibling: 2, hard: 3 };
  const bump = (t) => { if (rank[t] > rank[tier]) tier = t; };
  // the sample's own staging dir is legitimate cwd material — never a flag
  const ownStaging = join(CACHE, "staging", sid);
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
        raw = raw.slice(1).replace(/\\\\/g, "\\").replace(/^\"+/, "");
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

// ---------------------------------------------------------------- pi runner

function piArgs(workdir, prompt) {
  const ext = (name) => join(REPO, "src", "extensions", name, "index.ts");
  const extensions = ["core", "probe", "geometry", "ui", "drawing", "presentation", "experience"];
  const completionGate = `node ${join(REPO, "benchmarks", "cadtestbench", "completion-gate.mjs")}`;
  return [
    "-p", "--provider", PROVIDER, "--model", MODEL, "--thinking", THINKING,
    "--cwd", workdir, "--session-dir", join(workdir, ".sessions"),
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    ...extensions.flatMap((name) => ["-e", ext(name)]),
    "--skill", join(REPO, "skills", "pi-cad", "SKILL.md"),
    "--skill", join(REPO, "skills", "pi-cad-tools", "SKILL.md"),
    "--skill", join(REPO, "skills", "parametric-cad-modeling", "SKILL.md"),
    "--append-system-prompt",
    "Pi-CAD workflow state is authoritative. After routing, finish the current action card before implementation, and do not answer until the workflow reaches DONE. Before implementation, load the relevant engineering knowledge skill referenced by pi-cad.",
    "--autonomous", "--autonomous-gate", completionGate,
    "--autonomous-gate-retries", "16",
    "--autonomous-max-continuations", "32",
    "--autonomous-max-turns", "64",
    "--autonomous-max-tokens", "500000",
    "--autonomous-timeout-ms", String(TIMEOUT_MS),
    prompt,
  ];
}

function runPi(workdir, prompt, sessionId) {
  return new Promise((res) => {
    const child = spawn(AGENT_COMMAND, piArgs(workdir, prompt), {
      cwd: workdir,
      env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR,
             PI_CODING_AGENT_SESSION_DIR: join(workdir, ".sessions"),
             PI_CAD_REPO: REPO,
             PI_CAD_PROJECT_CWD: workdir,
             PI_CAD_HEADLESS: "1",
             // Catch semantic mistakes before implementation. The benchmark
             // deliberately spends its single independent review here rather
             // than after the entire candidate has already been built.
             PI_CAD_REQUIREMENTS_REVIEWER: "1",
             PI_CAD_FINAL_REVIEWER: "0" },
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
  const dir = join(workdir, ".sessions");
  if (!existsSync(dir)) return null;
  const allFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const matching = allFiles.filter((f) => f.includes(sessionId));
  const files = matching.length ? matching : allFiles;
  if (!files.length) return null;
  const u = { input: 0, cacheRead: 0, output: 0, total: 0, cost: 0 };
  let toolCalls = 0, candidateCommits = 0, errors = 0;
  for (const line of readFileSync(join(dir, files[files.length - 1]), "utf-8").split("\n")) {
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
  const run = latestRun(workdir);
  if (!run) return { terminal_phase: null, terminal_status: null };
  const s = run.state;
  return { terminal_phase: s.phase ?? null, terminal_status: s.status ?? null };
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
  if (run?.state?.currentArtifactPath) {
    const ap = run.state.currentArtifactPath;
    const sp = run.state.currentSourcePath;
    return {
      path: ap.startsWith("/") ? ap : join(workdir, ".pi-cad", "runs", run.runId, ap),
      source: sp ? (sp.startsWith("/") ? sp : join(workdir, sp)) : null,
      origin: `runs.${run.runId}.currentArtifactPath`,
    };
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
    evaluationError: sm.evaluation_error ?? null,
  };
}

// ---------------------------------------------------------------- main

// restore must run before anything that expects benchmark inputs on disk
if (args.includes("--restore-vault")) { restoreVault(); process.exit(0); }

function vaultTarPath(tar) {
  return tar.startsWith("/") ? tar : join(HERE, tar);
}

// 1. load benchmark inputs into memory BEFORE vaulting (on resume, pull
//    them out of the existing orig tars first)
const vaultActive = existsSync(join(CACHE, "manifest.json"));
const preloadDir = join(CACHE, "tmp-preload");
let baseDir = HERE;
if (vaultActive) {
  const vm = JSON.parse(readFileSync(join(CACHE, "manifest.json"), "utf-8"));
  for (const key of ["data", "sets"]) {
    const e = vm.find((x) => x.dest === key || x.dest.endsWith(`/${key}`));
    // Each vault tar already contains its top-level `data` or `sets`
    // directory. Extracting into preloadDir/key would create
    // tmp-preload/data/data and break interrupted-run resume.
    if (e) tarExtract(vaultTarPath(e.tar), preloadDir);
  }
  baseDir = preloadDir;
}
const SET = argValue("set");
const IDS = SET
  ? JSON.parse(readFileSync(join(baseDir, "sets", `${SET}.json`), "utf-8"))
  : [];
const sampleIds = IDS.sample_ids ?? IDS;
if (SET && !sampleIds.length) throw new Error(`set ${SET} empty or missing`);
const idList = SET ? sampleIds : (argValue("sample-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!idList.length) throw new Error("no samples: pass --set or --sample-ids");

const promptsFile = JSON.parse(readFileSync(join(baseDir, "data", `prompts.${PARTITION}.json`), "utf-8"));
const prompts = new Map(promptsFile.map((e) => [e.sample_id, e.adapted]));
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
const gitHead = sh(["git", "-C", REPO, "rev-parse", "HEAD"]).trim();
const piVersion = sh([AGENT_COMMAND, "--version"]).trim();

const experiment = {
  benchmark: { name: "CADTestBench", partition: PARTITION,
    dataset: "frozen local parquet (vaulted during run; see dataset-lock.json)",
    upstreamRevision: "e29283cc61db7329039d95b429766a50bfd37f89",
    promptPolicy: "strip code-generation prefix; append fixed task frame (extract-prompts.py)" },
  agent: { provider: PROVIDER, model: MODEL, thinking: THINKING },
  harness: { piCadCommit: gitHead, branch: sh(["git", "-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    piAgentVersion: piVersion,
    runtime: "Prime Agent",
    extensions: ["core", "probe", "geometry", "ui", "drawing", "presentation", "experience"],
    isolation: "L1 vault + L2 per-sample staging + L3 per-session audit gate" },
  execution: { timeoutMs: TIMEOUT_MS, retries: RETRIES },
  sampleIds: idList,
};
writeFileSync(join(CACHE, "experiment.json"), JSON.stringify(experiment, null, 2));
console.log(`[iso] run=${runName} commit=${gitHead.slice(0, 8)} samples=${idList.length} vaulted=${vaultManifest.length} paths`);

// 4. per-sample loop
const results = [];
for (const sampleId of idList) {
  const staging = join(CACHE, "staging", sampleId);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const prompt = prompts.get(sampleId);
  writeFileSync(join(staging, "prompt.txt"), prompt);

  const evalRoot = join(CACHE, "tmp", "eval");
  const gm = join(evalRoot, "generated_models", sampleId);
  mkdirSync(gm, { recursive: true });

  let result = null, metrics = null, wallMs = 0;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const started = Date.now();
    result = await runPi(staging, prompt, `pi-cad-${sampleId}`);
    wallMs = Date.now() - started;
    metrics = sessionMetrics(staging, `pi-cad-${sampleId}`);
    writeFileSync(join(staging, "stdout.log"), result.stdout);
    writeFileSync(join(staging, "stderr.log"), result.stderr);
    writeFileSync(join(staging, "run.json"),
      JSON.stringify({ sampleId, attempt, wallMs, code: result.code, signal: result.signal }, null, 2));
    const sessDir = join(staging, ".sessions");
    if (existsSync(sessDir)) {
      for (const f of readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"))) {
        copyFileSync(join(sessDir, f), join(staging, "session.jsonl"));
      }
    }
    if (existsSync(join(staging, ".pi-cad"))) {
      sh(["bash", "-c", `cp -r ${JSON.stringify(join(staging, ".pi-cad"))} ${JSON.stringify(join(staging, "pi-cad"))}`]);
    }
    const retryWorthy = result.code !== 0 &&
      /fetch failed|WebSocket error|provider_transport_failure/i.test(`${result.stdout}\n${result.stderr}`);
    if (!retryWorthy || attempt === RETRIES - 1) break;
  }

  // artifact + bridge
  const art = resolveArtifact(staging);
  let evaluation = null;
  if (art.path && existsSync(art.path)) {
    const gen = join(staging, "generated");
    mkdirSync(gen, { recursive: true });
    copyFileSync(art.path, join(gen, "final.step"));
    copyFileSync(art.path, join(gm, "final.step"));
    if (art.source && existsSync(art.source)) copyFileSync(art.source, join(gen, "source.py"));
    writeFileSync(join(gm, "gpt_generated.py"), WRAPPER);
  }

  // evaluator: untar dataset only while no agent is alive (L1)
  if (existsSync(join(gm, "gpt_generated.py"))) {
    const dataTmp = join(CACHE, "tmp", "data");
    if (dataEntry) tarExtract(vaultTarPath(dataEntry.tar), dataTmp);
    evaluation = evalSample(sampleId, evalRoot, join(dataTmp, "data", "hf"));
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
    rmSync(join(CACHE, "tmp"), { recursive: true, force: true });
  } else {
    evaluation = { error: art.origin === "NO_ARTIFACT" ? "NO_ARTIFACT" : "artifact missing on disk" };
  }

  // audit gate (L3)
  const audit = auditSession(join(staging, "session.jsonl"), sampleId);

  const manifest = {
    sample_id: sampleId,
    benchmark: experiment.benchmark, agent: experiment.agent,
    harness: { ...experiment.harness, terminal_phase: null, terminal_status: null, artifact_origin: art.origin },
    evaluation, integrity: audit,
    usage: metrics ? {
      input_tokens: metrics.input, cached_input_tokens: metrics.cacheRead,
      output_tokens: metrics.output, total_tokens: metrics.total,
      cost_usd: Number((metrics.cost ?? 0).toFixed(6)) } : null,
    execution: metrics ? {
      tool_calls: metrics.toolCalls, candidate_commits: metrics.candidateCommits,
      errors: metrics.errors, wall_ms: wallMs } : null,
    exit_code: result.code, exit_signal: result.signal,
  };
  const hs = harnessState(staging);
  manifest.workflow = {
    outcome: hs.terminal_status === "done"
      ? "done"
      : hs.terminal_status === "blocked_user"
        ? "blocked_user"
        : hs.terminal_status === "blocked_external"
        ? "blocked_external"
          : hs.terminal_status === "budget_exhausted"
            ? "budget_exhausted"
          : hs.terminal_status === "waiting_user"
            ? "invariant_violation"
            : "incomplete",
    interaction_mode: "headless",
  };
  manifest.requirements = { deferred_clarifications: clarificationDebt(staging) };
  manifest.harness.terminal_phase = hs.terminal_phase;
  manifest.harness.terminal_status = hs.terminal_status;
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  // archive sample, destroy staging (L2)
  tarCreate(join(CACHE, "archive", `${sampleId}.tar.gz`), join(CACHE, "staging"), sampleId);
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
const runRoot = join(HERE, "results", runName);
mkdirSync(join(runRoot, "samples"), { recursive: true });
copyFileSync(join(CACHE, "experiment.json"), join(runRoot, "experiment.json"));
for (const sid of idList) {
  tarExtract(join(CACHE, "archive", `${sid}.tar.gz`), join(runRoot, "samples"));
}
writeFileSync(join(runRoot, "raw-manifests.json"), JSON.stringify(results, null, 2));

const clean = results.filter((r) => r.integrity.tier === "clean" || r.integrity.tier === "toolchain");
const sum = (f) => clean.reduce((a, m) => a + (Number(f(m)) || 0), 0);
const nAll = results.length;
const exactAll = results.filter((r) => r.evaluation?.exactPass).length;
const exactClean = clean.filter((r) => r.evaluation?.exactPass).length;
const rsP = clean.reduce((a, m) => a + (m.evaluation?.rsGroups ?? []).filter((g) => g.all_passed).length, 0);
const rsT = clean.reduce((a, m) => a + (m.evaluation?.rsGroups ?? []).length, 0);
const summary = {
  runRoot, runName, harness: experiment.harness,
  integrity: {
    audited: nAll,
    clean_or_toolchain: clean.length,
    flagged: results.filter((r) => r.integrity.tier === "sibling" || r.integrity.tier === "hard")
      .map((r) => ({ sample_id: r.sample_id, tier: r.integrity.tier, flags: r.integrity.flags })),
  },
  observed: {
    exact: exactAll, samples: nAll,
    cadtests_passed: results.reduce((a, m) => a + (m.evaluation?.passed ?? 0), 0),
    cadtests_total: results.reduce((a, m) => a + (m.evaluation?.total ?? 0), 0),
    done: results.filter((r) => r.harness.terminal_phase === "done").length,
    cost_usd: Number(results.reduce((a, m) => a + (m.usage?.cost_usd ?? 0), 0).toFixed(4)),
  },
  clean: {
    exact: exactClean, samples: clean.length,
    cadtests_passed: sum((m) => m.evaluation?.passed ?? 0),
    cadtests_total: sum((m) => m.evaluation?.total ?? 0),
    rs_groups_passed: rsP, rs_groups_total: rsT,
    done: clean.filter((r) => r.harness.terminal_phase === "done").length,
    cost_usd: Number(clean.reduce((a, m) => a + (m.usage?.cost_usd ?? 0), 0).toFixed(4)),
    tokens: sum((m) => m.usage?.total_tokens ?? 0),
  },
};
writeFileSync(join(runRoot, "summary.json"), JSON.stringify(summary, null, 2));

restoreVault();
console.log("[iso] vault restored — ground truth back on disk");
console.log(JSON.stringify(summary, null, 2));
