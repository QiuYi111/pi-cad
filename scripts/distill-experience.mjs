#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { runProcess } = await jiti.import("../src/shared/process-runner.ts", { default: true });

const [, , requestArg, rootArg, customCommandJson = ""] = process.argv;
if (!requestArg || !rootArg) process.exit(2);

const requestPath = resolve(requestArg);
const root = resolve(rootArg);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jobStem = basename(requestPath, ".json");
const jobsDir = join(root, "distill-jobs");
const statusPath = join(jobsDir, `${jobStem}.job.json`);
const logPath = join(jobsDir, `${jobStem}.log`);
const candidateRoot = join(jobsDir, `${jobStem}.candidate`);
const replayReportPath = join(jobsDir, `${jobStem}.replay-result.json`);

async function treeDigest(directory) {
  const hash = createHash("sha256");
  async function visit(current, relative = "") {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = join(relative, entry.name);
      if (entry.isDirectory()) await visit(join(current, entry.name), rel);
      else if (entry.isFile()) hash.update(rel).update(await readFile(join(current, entry.name)));
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

async function prepareCandidate() {
  await rm(candidateRoot, { recursive: true, force: true });
  await mkdir(candidateRoot, { recursive: true });
  await cp(join(packageRoot, "skills"), join(candidateRoot, "skills"), { recursive: true });
  await cp(join(packageRoot, "workflow-packages"), join(candidateRoot, "workflow-packages"), { recursive: true });
  await writeFile(join(candidateRoot, "package.json"), `${JSON.stringify({
    name: "pi-cad-distillation-candidate", private: true, type: "module", pi: { skills: ["./skills"] },
  }, null, 2)}\n`, "utf8");
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function finishDistillation(success) {
  const statePath = join(root, "distill_state.json");
  const state = await readJson(statePath);
  if (success && state.active_cutoff_seq !== null) {
    state.last_distilled_seq = state.active_cutoff_seq;
    state.last_distilled_at = new Date().toISOString();
  }
  state.active_cutoff_seq = null;
  state.active_started_at = null;
  const indexPath = join(root, "index.jsonl");
  const rawIndex = await readFile(indexPath, "utf8").catch(() => "");
  const entries = rawIndex.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const latestByRun = new Map();
  for (const entry of entries) {
    if (entry.seq <= state.last_distilled_seq || entry.evaluation_status !== "evaluated") continue;
    const identity = entry.run_id || entry.session_path || entry.sha;
    const current = latestByRun.get(identity);
    if (!current || entry.seq > current.seq) latestByRun.set(identity, entry);
  }
  state.pending_transcript_tokens = [...latestByRun.values()]
    .reduce((sum, entry) => sum + entry.transcript_tokens, 0);
  await atomicWrite(statePath, state);
  await rm(join(root, "distill.lock"), { force: true });
  return state;
}

function defaultPrompt(request) {
  return [
    "Run a Reify experience distillation job.",
    `The immutable request manifest is: ${requestPath}`,
    `The experience index is: ${join(root, "index.jsonl")}`,
    `Process the global evaluated trajectory set selected by seq: ${(request.selected_seqs || []).join(", ") || `${request.from_seq}-${request.cutoff_seq}`}.`,
    "Treat records with the same run_id as one trajectory; never infer project-local scope from archive folders.",
    "Read canonical transcript.md files and deterministic metrics from the archive; do not invent or replace human ratings.",
    `Edit only the candidate skill tree under ${join(candidateRoot, "skills")} and candidate workflow packages under ${join(candidateRoot, "workflow-packages")}.`,
    "Extract only recurring, generalizable CAD strategies, failure modes, tool-use patterns, verification habits, and workflow defects supported by the trajectories.",
    "Change a workflow only when repeated evidence identifies a phase, transition, obligation, capability, or SOP defect. Keep its id stable and increment its version.",
    "For each low-rated real task, identify the earliest reproducible failure node and a minimal checkpoint immediately before it. Prefer tool errors, denied operations, review failures, stuck workflow state, and explicit user feedback over speculative judgement.",
    `Write checkpoint replay cases to ${join(jobsDir, `${jobStem}.replay.json`)} as one JSON object with exactly this outer shape: {"cases":[...]}. Each case must contain kind (repair or guard), seq, task, checkpoint, evidence, failureSignature, expectedRepair, and regressionGuard. Evidence must be a short exact quote from that trajectory or its human feedback. Include at most three low-rated repairs and one high-rated guard case.`,
    "Preserve unrelated working-tree changes. Do not copy project-specific dimensions unless they express reusable domain knowledge.",
    "Validate every changed skill and compile every changed workflow. If evidence does not justify a change, leave that file unchanged and explain why.",
    `Write a concise audit note to ${join(jobsDir, `${jobStem}.audit.md`)} describing evidence used, files changed, validation, model, and sequence range.`,
  ].join("\n");
}

async function run() {
  await mkdir(jobsDir, { recursive: true });
  const request = await readJson(requestPath);
  const originalSkillDigest = await treeDigest(join(packageRoot, "skills"));
  const originalWorkflowDigest = await treeDigest(join(packageRoot, "workflow-packages"));
  await prepareCandidate();
  let command;
  let args;
  let mode;
  let replayCommand;
  if (customCommandJson) {
    const parsed = JSON.parse(customCommandJson);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item)) {
      throw new Error("PI_CAD_DISTILL_COMMAND_JSON must be a non-empty JSON argv array");
    }
    [command, ...args] = parsed;
    replayCommand = JSON.stringify([command, ...args]);
    args.push(requestPath);
    mode = "custom";
  } else {
    const primeRepository = process.env.PRIME_AGENT_REPO;
    command = process.env.PI_CAD_DISTILL_PRIME_COMMAND
      || (primeRepository ? join(resolve(primeRepository), "prime-agent.sh") : "");
    if (!command) throw new Error("background distillation requires PRIME_AGENT_REPO or PI_CAD_DISTILL_PRIME_COMMAND");
    args = [
      "--dist",
      "--provider", process.env.PI_CAD_DISTILL_PROVIDER || "zai",
      "--model", process.env.PI_CAD_DISTILL_MODEL || "glm-5.3-flash",
      "--thinking", process.env.PI_CAD_DISTILL_THINKING || "low",
      "--no-session", "--mode", "text", "--print",
      defaultPrompt(request),
    ];
    replayCommand = command;
    mode = "builtin-prime";
  }

  const startedAt = new Date().toISOString();
  await atomicWrite(statusPath, {
    schema_version: 1,
    status: "running",
    mode,
    model: mode === "builtin-prime" ? `${process.env.PI_CAD_DISTILL_PROVIDER || "zai"}/${process.env.PI_CAD_DISTILL_MODEL || "glm-5.3-flash"}` : null,
    thinking: mode === "builtin-prime" ? process.env.PI_CAD_DISTILL_THINKING || "low" : null,
    pid: process.pid,
    request_path: requestPath,
    log_path: logPath,
    started_at: startedAt,
  });

  const env = { ...process.env };
  if (!env.ZAI_API_KEY && env.zai_api_key) env.ZAI_API_KEY = env.zai_api_key;
  const processResult = await runProcess({
    command,
    args,
    cwd: candidateRoot,
    env,
    timeoutMs: Number(process.env.PI_CAD_DISTILL_TIMEOUT_MS || 7_200_000),
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  });
  const exitCode = processResult.exitCode;
  await writeFile(logPath, `${processResult.stdout}${processResult.stderr}`, "utf8");

  const candidateSkillDigest = await treeDigest(join(candidateRoot, "skills"));
  const candidateWorkflowDigest = await treeDigest(join(candidateRoot, "workflow-packages"));
  const changed = candidateSkillDigest !== originalSkillDigest || candidateWorkflowDigest !== originalWorkflowDigest;
  let validationError = "";
  if (exitCode === 0 && changed) {
    if (await treeDigest(join(packageRoot, "skills")) !== originalSkillDigest || await treeDigest(join(packageRoot, "workflow-packages")) !== originalWorkflowDigest) {
      validationError = "live skill or workflow files changed while distillation was running";
    }
    const replayPath = join(jobsDir, `${jobStem}.replay.json`);
    if (!validationError) {
      try {
        let replay = await readJson(replayPath);
        // Older prompts and otherwise valid distillers sometimes emitted the
        // case array directly. Normalize that harmless representation before
        // validation and replay instead of discarding a completed job.
        if (Array.isArray(replay)) {
          replay = { cases: replay };
          await atomicWrite(replayPath, replay);
        }
        if (!Array.isArray(replay.cases) || replay.cases.length < 1 || replay.cases.length > 4) throw new Error("checkpoint replay must contain 1-4 cases");
        const sourceEntries = (await readFile(join(root, "index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
          .filter((entry) => entry.seq >= request.from_seq && entry.seq <= request.cutoff_seq && entry.evaluation_status === "evaluated");
        const used = new Set();
        for (const item of replay.cases) for (const key of ["kind", "seq", "task", "checkpoint", "evidence", "failureSignature", "expectedRepair", "regressionGuard"]) {
          if (item[key] === undefined || item[key] === null || item[key] === "") throw new Error(`checkpoint replay case is missing ${key}`);
        }
        for (const item of replay.cases) {
          if (!['repair', 'guard'].includes(item.kind)) throw new Error("checkpoint replay kind must be repair or guard");
          if (used.has(item.seq)) throw new Error("checkpoint replay seq must be unique");
          used.add(item.seq);
          const source = sourceEntries.find((entry) => entry.seq === Number(item.seq));
          if (!source) throw new Error(`checkpoint seq ${item.seq} is outside the immutable request`);
          const sourceText = `${source.feedback || ""}\n${await readFile(join(source.archive_path, "experience.md"), "utf8").catch(() => "")}`;
          if (!sourceText.includes(item.evidence)) throw new Error(`checkpoint seq ${item.seq} evidence is not present in the trajectory`);
          if (item.kind === "repair" && (source.quality === null || source.quality > 3)) throw new Error(`repair seq ${item.seq} is not low-rated`);
          if (item.kind === "guard" && (source.quality === null || source.quality < 4)) throw new Error(`guard seq ${item.seq} is not high-rated`);
        }
        if (sourceEntries.some((entry) => entry.quality !== null && entry.quality <= 3) && !replay.cases.some((item) => item.kind === "repair")) throw new Error("checkpoint replay omitted all low-rated trajectories");
        if (sourceEntries.some((entry) => entry.quality !== null && entry.quality >= 4) && !replay.cases.some((item) => item.kind === "guard")) throw new Error("checkpoint replay omitted the high-rated regression guard");
      } catch (error) { validationError = error instanceof Error ? error.message : String(error); }
    }
    if (!validationError) {
      for (const name of await readdir(join(candidateRoot, "workflow-packages", "mechanical"))) {
        if (!name.endsWith(".yaml")) continue;
        const checked = await runProcess({
          command: process.execPath,
          args: [join(packageRoot, "scripts", "desktop-validate-workflow.mjs"), join(candidateRoot, "workflow-packages", "mechanical", name)],
          cwd: packageRoot,
          env: process.env,
          timeoutMs: 60_000,
        });
        if (checked.exitCode !== 0) { validationError = `${name}: ${checked.stderr || checked.stdout}`; break; }
      }
    }
    if (!validationError) {
      const replayed = await runProcess({
        command: process.execPath,
        args: [join(packageRoot, "scripts", "evaluate-distillation-checkpoints.mjs"), join(jobsDir, `${jobStem}.replay.json`), root, candidateRoot, replayReportPath, replayCommand],
        cwd: packageRoot,
        env,
        timeoutMs: Number(process.env.PI_CAD_REPLAY_SUITE_TIMEOUT_MS || 1_800_000),
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 512 * 1024,
      });
      if (replayed.exitCode !== 0) validationError = replayed.stderr || replayed.stdout || "checkpoint replay failed";
    }
    if (!validationError) {
      await rm(join(packageRoot, "skills"), { recursive: true, force: true });
      await rm(join(packageRoot, "workflow-packages"), { recursive: true, force: true });
      await cp(join(candidateRoot, "skills"), join(packageRoot, "skills"), { recursive: true });
      await cp(join(candidateRoot, "workflow-packages"), join(packageRoot, "workflow-packages"), { recursive: true });
    }
  }
  if (validationError) await writeFile(logPath, `${processResult.stdout}${processResult.stderr}\nVALIDATION FAILED: ${validationError}\n`, "utf8");
  const success = exitCode === 0 && !validationError;
  const state = await finishDistillation(success);
  const completedAt = new Date().toISOString();
  const logDigest = createHash("sha256").update(await readFile(logPath)).digest("hex");
  await atomicWrite(statusPath, {
    schema_version: 1,
    status: success ? "complete" : "failed",
    mode,
    model: mode === "builtin-prime" ? `${process.env.PI_CAD_DISTILL_PROVIDER || "zai"}/${process.env.PI_CAD_DISTILL_MODEL || "glm-5.3-flash"}` : null,
    thinking: mode === "builtin-prime" ? process.env.PI_CAD_DISTILL_THINKING || "low" : null,
    pid: process.pid,
    exit_code: exitCode,
    request_path: requestPath,
    log_path: logPath,
    log_sha256: logDigest,
    started_at: startedAt,
    completed_at: completedAt,
    last_distilled_seq: state.last_distilled_seq,
    pending_transcript_tokens: state.pending_transcript_tokens,
    changed,
    validation_error: validationError || null,
    candidate_root: candidateRoot,
    replay_report: changed ? replayReportPath : null,
  });
}

run().catch(async (error) => {
  try {
    const state = await finishDistillation(false);
    await atomicWrite(statusPath, {
      schema_version: 1,
      status: "failed",
      pid: process.pid,
      request_path: requestPath,
      log_path: logPath,
      error: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
      last_distilled_seq: state.last_distilled_seq,
      pending_transcript_tokens: state.pending_transcript_tokens,
    });
  } catch {
    // Preserve the original failure and lock for manual recovery if state itself is unreadable.
  }
  process.exitCode = 1;
});
