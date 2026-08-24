import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import probe from "../src/extensions/probe/index.ts";
import core from "../src/extensions/core/index.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalReviewProfile } from "../src/domains/mechanical/review-profile.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { transitionRun } from "../src/harness/reducer.ts";
import { runFreshReviewV7 } from "../src/harness/review.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

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
