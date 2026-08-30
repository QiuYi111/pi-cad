#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , requestArg, rootArg, customCommandJson = ""] = process.argv;
if (!requestArg || !rootArg) process.exit(2);

const requestPath = resolve(requestArg);
const root = resolve(rootArg);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jobStem = basename(requestPath, ".json");
const jobsDir = join(root, "distill-jobs");
const statusPath = join(jobsDir, `${jobStem}.job.json`);
const logPath = join(jobsDir, `${jobStem}.log`);
const auditPath = join(jobsDir, `${jobStem}.audit.md`);

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
  state.pending_transcript_tokens = entries
    .filter((entry) => entry.seq > state.last_distilled_seq && entry.evaluation_status === "evaluated")
    .reduce((sum, entry) => sum + entry.transcript_tokens, 0);
  await atomicWrite(statePath, state);
  await rm(join(root, "distill.lock"), { force: true });
  return state;
}

function defaultPrompt(request) {
  return [
    "Run a Pi-CAD experience distillation job.",
    `The immutable request manifest is: ${requestPath}`,
    `The experience index is: ${join(root, "index.jsonl")}`,
    `Process complete evaluated trajectories from seq ${request.from_seq} through ${request.cutoff_seq}.`,
    "Read canonical transcript.md files and deterministic metrics from the archive; do not invent or replace human ratings.",
    `Inspect and improve reusable Pi-CAD skill knowledge under ${join(packageRoot, "skills")}.`,
    "Extract only recurring, generalizable CAD strategies, failure modes, tool-use patterns, and verification habits supported by the trajectories.",
    "Preserve unrelated working-tree changes. Do not copy project-specific dimensions unless they express reusable domain knowledge.",
    "Validate every changed skill and run the relevant repository tests. If evidence does not justify a skill change, leave skills unchanged and explain why.",
    "If you delegate evidence analysis to RLM children, wait for every child and collect its result before returning. Do not leave background analysis running.",
    "Treat benchmark evaluator contract or unit-convention defects as data-quality findings, not as reusable agent guidance.",
    "Write the audit note only after evidence collection, skill edits (if any), and validation are complete.",
    `Write a concise audit note to ${join(jobsDir, `${jobStem}.audit.md`)} describing evidence used, files changed, validation, model, and sequence range.`,
  ].join("\n");
}

async function run() {
  await mkdir(jobsDir, { recursive: true });
  const request = await readJson(requestPath);
  let command;
  let args;
  let mode;
  if (customCommandJson) {
    const parsed = JSON.parse(customCommandJson);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item)) {
      throw new Error("PI_CAD_DISTILL_COMMAND_JSON must be a non-empty JSON argv array");
    }
    [command, ...args] = parsed;
    args.push(requestPath);
    mode = "custom";
  } else {
    command = process.env.PI_CAD_DISTILL_PI_COMMAND || "prime-agent";
    args = [
      "--model", process.env.PI_CAD_DISTILL_MODEL || "zai/glm-5.3-flash",
      "--thinking", process.env.PI_CAD_DISTILL_THINKING || "low",
      "--print",
      "--cwd", packageRoot,
      "--session-dir", join(jobsDir, "sessions"),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--tools", "ipython",
      "--autonomous",
      "--autonomous-gate", `test -s '${auditPath}'`,
      "--autonomous-max-continuations", "8",
      "--autonomous-max-turns", "40",
      "--autonomous-max-tokens", "160000",
      "--autonomous-timeout-ms", "3600000",
      defaultPrompt(request),
    ];
    mode = "builtin-prime";
  }

  const startedAt = new Date().toISOString();
  await atomicWrite(statusPath, {
    schema_version: 1,
    status: "running",
    mode,
    model: mode === "builtin-prime" ? process.env.PI_CAD_DISTILL_MODEL || "zai/glm-5.3-flash" : null,
    thinking: mode === "builtin-prime" ? process.env.PI_CAD_DISTILL_THINKING || "low" : null,
    pid: process.pid,
    request_path: requestPath,
    log_path: logPath,
    started_at: startedAt,
  });

  const log = await open(logPath, "a");
  const env = { ...process.env };
  if (!env.ZAI_API_KEY && env.zai_api_key) env.ZAI_API_KEY = env.zai_api_key;
  const exitCode = await new Promise((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.once("error", reject);
    child.once("exit", (code) => fulfill(code ?? 1));
  }).finally(() => log.close());

  let success = exitCode === 0;
  let completionError = null;
  if (success && mode === "builtin-prime") {
    const audit = await readFile(auditPath, "utf8").catch(() => "");
    if (!audit.trim()) {
      success = false;
      completionError = `Prime exited successfully without the required audit artifact: ${auditPath}`;
    }
  }
  const state = await finishDistillation(success);
  const completedAt = new Date().toISOString();
  const logDigest = createHash("sha256").update(await readFile(logPath)).digest("hex");
  await atomicWrite(statusPath, {
    schema_version: 1,
    status: success ? "complete" : "failed",
    mode,
    model: mode === "builtin-prime" ? process.env.PI_CAD_DISTILL_MODEL || "zai/glm-5.3-flash" : null,
    thinking: mode === "builtin-prime" ? process.env.PI_CAD_DISTILL_THINKING || "low" : null,
    pid: process.pid,
    exit_code: exitCode,
    ...(completionError ? { completion_error: completionError } : {}),
    request_path: requestPath,
    log_path: logPath,
    log_sha256: logDigest,
    started_at: startedAt,
    completed_at: completedAt,
    last_distilled_seq: state.last_distilled_seq,
    pending_transcript_tokens: state.pending_transcript_tokens,
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
