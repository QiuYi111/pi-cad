#!/usr/bin/env node

import { basename } from "node:path";
import { createJiti } from "jiti";

const [, , projectPath, primeRepo, qualityArg, difficultyArg, feedback = "", ...sessionPaths] = process.argv;
if (!projectPath || !primeRepo || !sessionPaths.length) throw new Error("project, Prime repository, ratings, and sessions are required");
const quality = Number(qualityArg);
const difficulty = Number(difficultyArg);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const store = await jiti.import("../src/experience/store.ts", { default: true });
process.env.PRIME_AGENT_REPO = primeRepo;

const entries = [];
for (const sessionPath of sessionPaths) {
  const archived = await store.finalizeExperience({
    runId: basename(sessionPath, ".jsonl"), workflow: "desktop.conversation",
    projectPath, sessionPath, outcome: "complete", outcomeReason: "Rated in Pi-CAD Desktop",
  });
  entries.push(await store.recordEvaluation({ sha: archived.sha }, quality, difficulty, feedback));
}

const state = await store.readDistillState();
const request = await store.maybeBeginDistillation();
if (request.triggered && request.request_path) await store.runConfiguredDistillation(request.request_path);
process.stdout.write(`${JSON.stringify({
  rated: entries.length,
  triggered: request.triggered,
  pendingTokens: state.pending_transcript_tokens,
  thresholdTokens: state.threshold_tokens,
  message: request.triggered
    ? "Rating saved. The distillation threshold was reached and a background job started."
    : `Rating saved. ${Math.max(0, state.threshold_tokens - state.pending_transcript_tokens)} evaluated tokens remain before automatic distillation.`,
})}\n`);
