import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  completeDistillation,
  findExperience,
  getExperience,
  maybeBeginDistillation,
  readDistillState,
  readExperience,
  recordEvaluation,
  runConfiguredDistillation,
  searchExperience,
} from "../src/experience/store.ts";
import type { ExperienceIndexEntry } from "../src/experience/types.ts";

test("experience index supports evaluation, retrieval, bounded reads, and atomic distillation cutoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-experience-"));
  const previousRoot = process.env.PI_CAD_EXPERIENCE_ROOT;
  const previousThreshold = process.env.PI_CAD_DISTILL_THRESHOLD_TOKENS;
  process.env.PI_CAD_EXPERIENCE_ROOT = root;
  process.env.PI_CAD_DISTILL_THRESHOLD_TOKENS = "10";
  try {
    const archive = join(root, "mechanical-design", "phone-stand", "run", "sha-one");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "transcript.md"), "# Phone stand\n\nInterference check failed.\nRevised hinge clearance.\n", "utf8");
    const entry: ExperienceIndexEntry = {
      schema_version: 1,
      seq: 1,
      run_id: "run-1",
      workflow: "design-greenfield-part-functional",
      project_name: "phone-stand",
      project_path: "/projects/phone-stand",
      timestamp: "2026-08-27T10:00:00Z",
      sha: "sha-one",
      archive_path: archive,
      session_path: "/sessions/one.jsonl",
      model: "sol",
      reasoning: "medium",
      analysis_status: "complete",
      quality: null,
      difficulty: null,
      score: null,
      score_version: 1,
      transcript_tokens: 20,
      processed_tokens: 1000,
      duration_s: 120,
      evaluation_status: "pending",
    };
    await writeFile(join(root, "index.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");

    const evaluated = await recordEvaluation({ seq: 1 }, 5, 4);
    assert.equal(evaluated.evaluation_status, "evaluated");
    assert.ok((evaluated.score || 0) > 80);
    assert.equal((await getExperience({ sha: "sha-one" })).quality, 5);

    const results = await searchExperience({ query: "interference", min_quality: 4, sort: "score" });
    assert.deepEqual(results.map((item) => item.seq), [1]);
    const read = await readExperience({ seq: 1 }, 3, 3);
    assert.equal(read.text, "Interference check failed.");
    const found = await findExperience({ seq: 1 }, "hinge", 0);
    assert.equal(found[0].line, 4);

    assert.equal((await readDistillState()).pending_transcript_tokens, 20);
    const first = await maybeBeginDistillation();
    assert.equal(first.triggered, true);
    assert.equal(first.cutoff_seq, 1);
    const failed = await completeDistillation(false);
    assert.equal(failed.last_distilled_seq, 0);
    assert.equal(failed.pending_transcript_tokens, 20);
    assert.equal((await maybeBeginDistillation()).triggered, true);
    const complete = await completeDistillation(true);
    assert.equal(complete.last_distilled_seq, 1);
    assert.equal(complete.pending_transcript_tokens, 0);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CAD_EXPERIENCE_ROOT; else process.env.PI_CAD_EXPERIENCE_ROOT = previousRoot;
    if (previousThreshold === undefined) delete process.env.PI_CAD_DISTILL_THRESHOLD_TOKENS; else process.env.PI_CAD_DISTILL_THRESHOLD_TOKENS = previousThreshold;
    await rm(root, { recursive: true, force: true });
  }
});

test("configured distillation runs in a detached supervisor and advances the cursor only after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-distill-worker-"));
  const request = join(root, "distill-1-1.json");
  const previousCommand = process.env.PI_CAD_DISTILL_COMMAND_JSON;
  try {
    await writeFile(join(root, "index.jsonl"), `${JSON.stringify({ seq: 1, evaluation_status: "evaluated", transcript_tokens: 20 })}\n`, "utf8");
    await writeFile(join(root, "distill_state.json"), `${JSON.stringify({
      schema_version: 1,
      last_distilled_seq: 0,
      pending_transcript_tokens: 20,
      threshold_tokens: 10,
      last_distilled_at: null,
      active_cutoff_seq: 1,
      active_started_at: new Date().toISOString(),
    })}\n`, "utf8");
    await writeFile(join(root, "distill.lock"), "", "utf8");
    await writeFile(request, `${JSON.stringify({ schema_version: 1, from_seq: 1, cutoff_seq: 1, transcript_tokens: 20 })}\n`, "utf8");
    process.env.PI_CAD_DISTILL_COMMAND_JSON = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);

    assert.equal(await runConfiguredDistillation(request, root), "queued");
    const statusPath = join(root, "distill-jobs", "distill-1-1.job.json");
    let status: any = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { status = JSON.parse(await readFile(statusPath, "utf8")); } catch { /* worker has not written status yet */ }
      if (status?.status === "complete" || status?.status === "failed") break;
      await new Promise((fulfill) => setTimeout(fulfill, 25));
    }
    assert.equal(status?.status, "complete");
    assert.equal((await readDistillState(root)).last_distilled_seq, 1);
    assert.equal((await readDistillState(root)).pending_transcript_tokens, 0);
  } finally {
    if (previousCommand === undefined) delete process.env.PI_CAD_DISTILL_COMMAND_JSON; else process.env.PI_CAD_DISTILL_COMMAND_JSON = previousCommand;
    await rm(root, { recursive: true, force: true });
  }
});
