#!/usr/bin/env node

import { basename, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const [, , projectPath, primeRepo, qualityArg, difficultyArg, ...sessionPaths] = process.argv;
if (!projectPath || !primeRepo || !sessionPaths.length) throw new Error("project, Prime repository, ratings, and sessions are required");
const quality = Number(qualityArg);
const difficulty = Number(difficultyArg);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const store = await jiti.import("../src/experience/store.ts", { default: true });
process.env.PRIME_AGENT_REPO = primeRepo;

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const entries = [];
for (let index = 0; index < sessionPaths.length; index++) {
  const sessionPath = sessionPaths[index];
  emit({ state: "running", processed: index, total: sessionPaths.length, message: `Archiving ${basename(sessionPath)}…` });
  const entry = await store.finalizeExperience({
    runId: basename(sessionPath, ".jsonl"),
    workflow: "desktop.selection",
    projectPath,
    sessionPath,
    outcome: "complete",
    outcomeReason: "Selected for distillation in Pi-CAD Desktop",
  });
  entries.push(await store.recordEvaluation({ sha: entry.sha }, quality, difficulty));
  emit({ state: "running", processed: index + 1, total: sessionPaths.length, message: `Archived ${index + 1} of ${sessionPaths.length} trajectories.` });
}

const root = store.experienceRoot();
const request = await store.beginDistillationNow(root);
if (!request.triggered || !request.request_path) {
  emit({ state: "complete", processed: sessionPaths.length, total: sessionPaths.length, message: "Trajectories archived. A distillation job is already running or no new evaluated tokens remain.", outputPath: root });
  process.exit(0);
}
await store.runConfiguredDistillation(request.request_path, root);
const stem = basename(request.request_path, ".json");
const jobPath = join(root, "distill-jobs", `${stem}.job.json`);
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let job;
  try { job = JSON.parse(await readFile(jobPath, "utf8")); } catch { continue; }
  const terminal = job.status === "complete" || job.status === "failed";
  emit({
    state: terminal ? job.status : "running",
    processed: terminal ? sessionPaths.length : Math.max(0, sessionPaths.length - 1),
    total: sessionPaths.length,
    message: terminal
      ? (job.status === "complete"
          ? (job.changed ? "Reusable experience updated." : "Validation complete. No reusable change was published.")
          : job.error || "Distillation failed.")
      : "Prime is extracting reusable engineering experience…",
    outputPath: job.log_path || dirname(jobPath),
  });
  if (terminal) process.exit(job.status === "complete" ? 0 : 1);
}
