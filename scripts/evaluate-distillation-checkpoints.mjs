#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";

const [, , replayArg, rootArg, candidateArg, reportArg, primeCommandArg] = process.argv;
if (!replayArg || !rootArg || !candidateArg || !reportArg || !primeCommandArg) process.exit(2);
const primeArgv = primeCommandArg.trim().startsWith("[")
  ? JSON.parse(primeCommandArg)
  : [primeCommandArg];
if (!Array.isArray(primeArgv) || primeArgv.length === 0 || primeArgv.some((item) => typeof item !== "string" || !item)) {
  throw new Error("checkpoint command must be an executable path or non-empty JSON argv array");
}
const [primeCommand, ...primePrefixArgs] = primeArgv;
const replayPath = resolve(replayArg);
const root = resolve(rootArg);
const candidateRoot = resolve(candidateArg);
const reportPath = resolve(reportArg);
const replay = JSON.parse(await readFile(replayPath, "utf8"));
const index = (await readFile(join(root, "index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { runProcess } = await jiti.import("../src/shared/process-runner.ts", { default: true });

function modelOf(entry) {
  const [provider, ...model] = String(entry.model || "").split("/");
  return model.length ? { provider, model: model.join("/"), thinking: entry.reasoning || "low" } : {
    provider: process.env.PI_CAD_REPLAY_PROVIDER || process.env.PI_CAD_DISTILL_PROVIDER || "zai",
    model: process.env.PI_CAD_REPLAY_MODEL || process.env.PI_CAD_DISTILL_MODEL || "glm-5.3-flash",
    thinking: process.env.PI_CAD_REPLAY_THINKING || "low",
  };
}

async function primeText(cwd, model, prompt) {
  const result = await runProcess({
    command: primeCommand,
    args: [...primePrefixArgs, "--provider", model.provider, "--model", model.model, "--thinking", model.thinking, "--no-session", "--mode", "text", "--print", prompt],
    cwd, env: process.env, timeoutMs: Number(process.env.PI_CAD_REPLAY_TIMEOUT_MS || 300_000),
    maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || `checkpoint process exited ${result.exitCode}`);
  return result.stdout.trim();
}

const results = [];
for (const item of replay.cases) {
  const entry = index.find((candidate) => candidate.seq === Number(item.seq));
  if (!entry || entry.evaluation_status !== "evaluated") throw new Error(`checkpoint seq ${item.seq} is not an evaluated trajectory`);
  const model = modelOf(entry);
  const workflowFile = join(candidateRoot, "workflow-packages", `${String(entry.workflow || "").replace(".", "/")}.yaml`);
  const workflow = await readFile(workflowFile, "utf8").catch(() => "");
  const continuation = await primeText(candidateRoot, model, [
    "Continue one real engineering task from a saved checkpoint.",
    "Choose only the next bounded action; do not finish the whole task.",
    `Task:\n${item.task}`,
    `Checkpoint:\n${item.checkpoint}`,
    workflow ? `Current workflow package:\n${workflow}` : "",
  ].filter(Boolean).join("\n\n"));
  const judgeModel = {
    provider: process.env.PI_CAD_REPLAY_JUDGE_PROVIDER || process.env.PI_CAD_DISTILL_PROVIDER || "zai",
    model: process.env.PI_CAD_REPLAY_JUDGE_MODEL || process.env.PI_CAD_DISTILL_MODEL || "glm-5.3-flash",
    thinking: process.env.PI_CAD_REPLAY_JUDGE_THINKING || "low",
  };
  const judgement = await primeText(dirname(candidateRoot), judgeModel, [
    "Judge one checkpoint continuation. Return exactly PASS or FAIL on the first line, then one short reason.",
    `Known failure:\n${item.failureSignature}`,
    `Expected repair:\n${item.expectedRepair}`,
    `Regression guard:\n${item.regressionGuard}`,
    `Candidate next action:\n${continuation}`,
  ].join("\n\n"));
  results.push({ kind: item.kind, seq: item.seq, pass: /^PASS\b/i.test(judgement), continuation, judgement });
}
const report = { schema_version: 1, kind: "real-task-checkpoint-replay", passed: results.every((item) => item.pass), results };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.passed ? 0 : 1;
