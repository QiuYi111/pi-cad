import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import probe from "../src/extensions/probe/index.ts";
import core from "../src/extensions/core/index.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalReviewProfile } from "../src/domains/mechanical/review-profile.ts";
import { selectReviewCandidate } from "../src/domains/mechanical/review-executor-v7.ts";
import { mechanicalReviewRegressionEvent } from "../src/domains/mechanical/control-actions-v7.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { transitionRun } from "../src/harness/reducer.ts";
import { runFreshReviewV7 } from "../src/harness/review.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { recordObservationV7 } from "../src/harness/observations.ts";

test("fresh Mechanical reviewer selects the authoritative shape instead of an earlier source artifact", () => {
  const selected = selectReviewCandidate({
    "candidate:source": { id: "candidate:source", path: "models/part.py", sha256: "source", role: "candidate-source" },
    "candidate:authoritative": { id: "candidate:authoritative", path: "exports/part.step", sha256: "step", role: "candidate-authoritative" },
  });
  assert.equal(selected?.path, "exports/part.step");
});

test("failed v7 review selects the workflow's editable regression edge", () => {
  const workflow = { phases: {
    review: { purpose: "Review", actions: ["cad_submit_for_review"], grants: ["observe"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: [], hooks: [], reviewProfile: "mechanical.design-review", transitions: { revise: { target: "build" }, accepted: { target: "done" } } },
    build: { purpose: "Build", actions: ["cad_commit_candidate"], grants: ["file_edit_source"], writeScopes: ["project:source", "project:deliverable"], recordObligations: [], evidenceObligations: [], contextProviders: [], hooks: [], transitions: { candidate_committed: { target: "review" } } },
    done: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: [], hooks: [], transitions: {}, terminal: true },
  } } as any;
  assert.equal(mechanicalReviewRegressionEvent({ phase: "review" } as any, workflow), "revise");
});

test("Generic Review Runner pins a fresh Mechanical profile result before acceptance", async () => {
  const pi: any = { registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; }, appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} } };
  core(pi);
  probe(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-v7-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_submit_for_review", "transition"], grants: ["observe", "transition"], writeScopes: ["run:observation", "run:state"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.design-review", transitions: { accepted: { target: "done" } } },
      done: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    const loaded = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    assert.throws(() => transitionRun(loaded.state, workflow, "accepted"), /requires a current/);
    let allowed: string[] = [];
    const reviewed = await runFreshReviewV7({ cwd, workflowRunId: loaded.state.runId, registries: mechanicalRegistries, profile: mechanicalReviewProfile("mechanical.design-review"), executor: { async execute(input) { allowed = input.allowedActions; return { schema: 1, verdict: "pass", summary: "ready", findings: [] }; } } });
    assert.deepEqual(allowed, ["cad_probe"]);
    const closed = await new HarnessRunStoreV7(cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({ state: transitionRun(state, workflow, "accepted"), event: { type: "Accepted" } }));
    assert.equal(closed.state.status, "done");
    assert.equal(reviewed.state.latestReview?.profileId, "mechanical.design-review");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("fresh review receives candidate-bound programmable probes and caches the identical subject", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-programmable-v7-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/replay-review", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_probe", "cad_submit_for_review", "transition"], grants: ["observe", "transition"], writeScopes: ["run:observation", "run:state"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.design-review", transitions: { accepted: { target: "done" } } },
      done: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    const started = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    const store = new HarnessRunStoreV7(cwd, started.state.runId);
    await store.mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, artifacts: { candidate: { id: "candidate", path: "exports/part.step", sha256: "a".repeat(64), role: "candidate-authoritative" } } },
      event: { type: "CandidateBound" },
    }));
    await recordObservationV7({
      cwd, workflowRunId: started.state.runId, registries: mechanicalRegistries, tool: "cad_probe", preset: "python",
      headline: "four holes", subjectHash: "a".repeat(64), facts: [], visuals: [], diagnostics: [],
      provenance: { programmableProbe: { protocol: "pi-cad/programmable-probe/v1", purpose: "count holes", code: "result = {'holeCount': 4}", scriptHash: "b".repeat(64) } },
      payload: { result: { holeCount: 4 } },
    });
    let calls = 0;
    let replayInput: any;
    const executor = { async execute(input: any) { calls += 1; replayInput = input; return { schema: 1 as const, verdict: "pass" as const, summary: "verified", findings: [] }; } };
    const profile = mechanicalReviewProfile("mechanical.design-review");
    const reviewed = await runFreshReviewV7({ cwd, workflowRunId: started.state.runId, registries: mechanicalRegistries, profile, executor });
    await runFreshReviewV7({ cwd, workflowRunId: started.state.runId, registries: mechanicalRegistries, profile, executor });
    assert.equal(calls, 1);
    assert.equal(replayInput.programmableObservations[0].purpose, "count holes");
    assert.deepEqual(replayInput.programmableObservations[0].expectedResult, { holeCount: 4 });
    const closed = await store.mutate(mechanicalRegistries, ({ state }) => ({ state: transitionRun(state, workflow, "accepted"), event: { type: "Accepted" } }));
    assert.equal(reviewed.state.latestReview?.verdict, "pass");
    assert.equal(closed.state.status, "done");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
