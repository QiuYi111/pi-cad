import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  completeDistillation,
  finalizeExperience,
  findExperience,
  getExperience,
  maybeBeginDistillation,
  readDistillState,
  readExperience,
  recordBenchmarkEvaluation,
  recordEvaluation,
  runConfiguredDistillation,
  searchExperience,
} from "../src/experience/store.ts";
import type { ExperienceIndexEntry } from "../src/experience/types.ts";
import { renderExperienceView } from "../src/experience/view.ts";
import { dispatchSidecarRequest } from "../src/authority/sidecar.ts";

const execFileAsync = promisify(execFile);

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
      benchmark_evaluation: null,
    };
    await writeFile(join(root, "index.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");

    const evaluated = await recordEvaluation({ seq: 1 }, 5, 4, "The hinge repair worked.");
    assert.equal(evaluated.evaluation_status, "evaluated");
    assert.ok((evaluated.score || 0) > 80);
    assert.equal(evaluated.feedback, "The hinge repair worked.");
    assert.equal((await getExperience({ sha: "sha-one" })).quality, 5);

    const reevaluated = await recordEvaluation({ seq: 1 }, 5, 4);
    assert.equal(reevaluated.feedback, "The hinge repair worked.");

    const benchmarked = await recordBenchmarkEvaluation({ seq: 1 }, {
      benchmark: "CADTestBench",
      partition: "detailed",
      sample_id: "00001817",
      passed: 17,
      total: 17,
      exact_pass: true,
      rs_passed: 9,
      rs_total: 9,
      integrity_status: "clean",
      failures: [{
        requirement_id: "hinge_clearance",
        description: "Hinge must rotate without collision",
        message: "Measured clearance was negative",
      }],
    });
    assert.equal(benchmarked.benchmark_evaluation?.score, 100);
    assert.equal(benchmarked.benchmark_evaluation?.failures?.[0]?.requirement_id, "hinge_clearance");
    assert.deepEqual(
      (await searchExperience({ benchmark: "CADTestBench", benchmark_exact_pass: true })).map((item) => item.seq),
      [1],
    );
    const authorResult = await dispatchSidecarRequest("author", root, {
      schema: 1, op: "experience-get", identifier: { seq: 1 },
    });
    assert.equal(authorResult.ok, true);
    assert.doesNotMatch(JSON.stringify(authorResult), /archive_path|session_path|project_path/);
    const reviewerResult = await dispatchSidecarRequest("reviewer", root, {
      schema: 1, op: "experience-get", identifier: { seq: 1 },
    });
    assert.equal(reviewerResult.ok, false);
    assert.match(JSON.stringify(reviewerResult), /reviewer endpoint does not expose operation/);

    const results = await searchExperience({ query: "interference", min_quality: 4, sort: "score" });
    assert.deepEqual(results.map((item) => item.seq), [1]);
    const naturalQuery = await searchExperience({
      query: "mechanical benchmark investigate phone hinge interference and clearance STEP release gate",
    });
    assert.deepEqual(naturalQuery.map((item) => item.seq), [1]);
    assert.deepEqual((await searchExperience({ query: "negative hinge clearance" })).map((item) => item.seq), [1]);
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

test("failed analyzer archives remain keyword searchable and bounded-readable from raw JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-experience-raw-"));
  const previousRoot = process.env.PI_CAD_EXPERIENCE_ROOT;
  process.env.PI_CAD_EXPERIENCE_ROOT = root;
  try {
    const archive = join(root, "benchmark", "part", "run", "sha-raw");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "transcript.jsonl"), '{"message":"repair the reversed support arm"}\n', "utf8");
    const entry: ExperienceIndexEntry = {
      schema_version: 1, seq: 1, run_id: "raw-run", workflow: "mechanical.benchmark",
      project_name: "part", project_path: "/projects/part", timestamp: "2026-08-28T00:00:00Z",
      sha: "sha-raw", archive_path: archive, session_path: "/sessions/raw.jsonl",
      model: "sol", reasoning: "minimal", analysis_status: "failed", analysis_error: "offline",
      quality: null, difficulty: null, score: null, score_version: 1, transcript_tokens: 12,
      processed_tokens: null, duration_s: null, evaluation_status: "pending", benchmark_evaluation: null,
    };
    await writeFile(join(root, "index.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    assert.deepEqual((await searchExperience({ query: "reversed support" })).map((item) => item.seq), [1]);
    assert.deepEqual(
      (await searchExperience({ query: "benchmark failure with a rectangular reversed support arm and STEP source" })).map((item) => item.seq),
      [1],
    );
    assert.match((await readExperience({ seq: 1 })).text, /reversed support arm/);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CAD_EXPERIENCE_ROOT; else process.env.PI_CAD_EXPERIENCE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-facing experience view removes harness, skill, phase-card, and recursive retrieval prompts", () => {
  const rows = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Build a rounded enclosure.\n\nBenchmark execution contract: inject workflow policy and search old traces." }] } },
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Checking prior hinge failure" },
      { type: "toolCall", id: "search-1", name: "cad_experience_search", arguments: { query: "hinge" } },
      { type: "toolCall", id: "skill-1", name: "ipython", arguments: { code: "Path('/opt/pi-cad/cad/SKILL.md').read_text()" } },
      { type: "toolCall", id: "build-1", name: "ipython", arguments: { code: "result = Box(10, 20, 3)" } },
    ] } },
    { type: "message", message: { role: "toolResult", toolCallId: "search-1", toolName: "cad_experience_search", content: [{ type: "text", text: "old harness contract" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "skill-1", toolName: "ipython", content: [{ type: "text", text: "---\nname: cad\n# Pi-CAD Python API\nfull skill" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "build-1", toolName: "ipython", content: [{ type: "text", text: "Solid volume=600" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Geometry verified and released." }] } },
  ];
  const view = renderExperienceView(rows.map((row) => JSON.stringify(row)).join("\n"), {
    workflow: "mechanical.benchmark", outcome: "complete", model: "sol", reasoning: "minimal",
  });
  assert.match(view, /Build a rounded enclosure/);
  assert.match(view, /Checking prior hinge failure/);
  assert.match(view, /Box\(10, 20, 3\)/);
  assert.match(view, /Solid volume=600/);
  assert.match(view, /Geometry verified and released/);
  assert.doesNotMatch(view, /Benchmark execution contract|cad_experience_search|SKILL\.md|Pi-CAD Python API|old harness contract/);
});

test("incomplete Prime trajectories are archived and remain benchmark-scorable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-experience-incomplete-"));
  const project = join(root, "project");
  const session = join(project, ".prime-sessions", "failed.jsonl");
  const previousRoot = process.env.PI_CAD_EXPERIENCE_ROOT;
  process.env.PI_CAD_EXPERIENCE_ROOT = join(root, "library");
  try {
    await mkdir(join(project, ".prime-sessions"), { recursive: true });
    await writeFile(session, `${JSON.stringify({
      type: "message", id: "m1", parentId: null, timestamp: "2026-08-28T00:00:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "authority recovery failed" }] },
    })}\n`, "utf8");
    const archived = await finalizeExperience({
      runId: "run-incomplete", workflow: "mechanical.benchmark", projectPath: project,
      sessionPath: session, model: "openai-codex/gpt-5.6-sol", reasoning: "minimal",
      outcome: "incomplete", outcomeReason: "workflow remained in build",
    });
    assert.equal(archived.outcome, "incomplete");
    assert.equal(archived.outcome_reason, "workflow remained in build");
    const scored = await recordBenchmarkEvaluation({ seq: archived.seq }, {
      benchmark: "CADTestBench", partition: "detailed", sample_id: "00000633",
      passed: 0, total: 13, exact_pass: false, rs_passed: 0, rs_total: 12,
      integrity_status: "clean",
    });
    assert.equal(scored.benchmark_evaluation?.score, 0);
    assert.equal(scored.evaluation_status, "evaluated");
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CAD_EXPERIENCE_ROOT; else process.env.PI_CAD_EXPERIENCE_ROOT = previousRoot;
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

test("built-in distillation uses the packaged Prime dist entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-distill-packaged-prime-"));
  const request = join(root, "distill-1-1.json");
  const prime = join(root, "prime-agent");
  const previousPrime = process.env.PRIME_AGENT_REPO;
  try {
    await mkdir(prime, { recursive: true });
    await writeFile(join(prime, "prime-agent.sh"), [
      "#!/usr/bin/env bash",
      "if [[ \"${1:-}\" != \"--dist\" ]]; then",
      "  echo 'tsx unavailable in packaged runtime' >&2",
      "  exit 9",
      "fi",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    await chmod(join(prime, "prime-agent.sh"), 0o755);
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
    process.env.PRIME_AGENT_REPO = prime;

    await execFileAsync(process.execPath, [join(process.cwd(), "scripts", "distill-experience.mjs"), request, root]);
    const status = JSON.parse(await readFile(join(root, "distill-jobs", "distill-1-1.job.json"), "utf8"));
    assert.equal(status.status, "complete");
    assert.equal(status.exit_code, 0);
  } finally {
    if (previousPrime === undefined) delete process.env.PRIME_AGENT_REPO; else process.env.PRIME_AGENT_REPO = previousPrime;
    await rm(root, { recursive: true, force: true });
  }
});

test("real-task checkpoint replay runs only one bounded next action and an independent judgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-checkpoint-replay-"));
  try {
    const candidate = join(root, "candidate");
    await mkdir(join(candidate, "workflow-packages", "mechanical"), { recursive: true });
    await writeFile(join(candidate, "workflow-packages", "mechanical", "one-shot.yaml"), "schema: 1\nid: mechanical.one-shot\nversion: 1\nworkflow: {}\n");
    await writeFile(join(root, "index.jsonl"), `${JSON.stringify({ seq: 1, evaluation_status: "evaluated", model: null, reasoning: "low", workflow: "mechanical.one-shot" })}\n`);
    const replay = join(root, "replay.json");
    // Direct arrays were emitted by an early real distillation run and are
    // accepted for backward compatibility.
    await writeFile(replay, `${JSON.stringify([{
      kind: "repair", seq: 1, task: "Make a stand", checkpoint: "The support faces backward", evidence: "wrong orientation",
      failureSignature: "wrong orientation", expectedRepair: "inspect the support direction", regressionGuard: "retain the hinge",
    }])}\n`);
    const fakePrime = join(root, "fake-prime.mjs");
    await writeFile(fakePrime, "const prompt=process.argv.at(-1)||''; process.stdout.write(/^Judge/.test(prompt)?'PASS\\nChecks orientation before rebuilding.\\n':'Inspect the support direction against the phone datum.\\n');\n");
    const report = join(root, "report.json");
    await execFileAsync(process.execPath, [join(process.cwd(), "scripts", "evaluate-distillation-checkpoints.mjs"), replay, root, candidate, report, JSON.stringify([process.execPath, fakePrime])]);
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.passed, true);
    assert.equal(result.results[0].kind, "repair");
  } finally { await rm(root, { recursive: true, force: true }); }
});
