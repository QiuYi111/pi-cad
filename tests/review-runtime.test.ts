import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bootstrapAgentApiContracts } from "../src/agent-api/bootstrap.ts";
import { dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { ReviewRuntime } from "../src/authority/review-runtime.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { commitWorkspace } from "../src/harness/commit.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("review runtime admits one reviewer per immutable candidate and persists an evidence-backed result", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-runtime-"));
  try {
    const workflow = compileWorkflowDefinition({
      schema: 1, id: "test/review-runtime", version: "1.0.0", parametersSchema: {}, initialPhase: "final_review",
      phases: {
        final_review: {
          purpose: "Independent final review", actions: ["cad_commit", "cad_submit_for_review", "transition"], grants: ["file_read", "transition"], writeScopes: [],
          recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review",
          transitions: { accepted: { target: "done" } },
        },
        done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
      },
    }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "immutable-candidate");
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "final-candidate", artifacts: [{ path: "candidate.step", role: "authoritative-candidate-design" }] });
    let launches = 0;
    let runtime!: ReviewRuntime;
    runtime = new ReviewRuntime(cwd, async ({ reviewId }) => {
      launches += 1;
      await runtime.complete(reviewId, { verdict: "pass", summary: "geometry checks pass", findings: [{ id: "geometry", severity: "info", finding: "candidate is measurable", evidenceRefs: ["probe:geometry:abc"] }] });
    });
    const first = await runtime.submit(commit.id);
    await runtime.waitForIdle(first.reviewId);
    const second = await runtime.submit(commit.id);
    assert.equal(first.reviewId, second.reviewId);
    assert.equal(launches, 1);
    assert.equal((await runtime.current(first.reviewId))?.status, "pass");
    const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(active?.state.latestReview?.subjectCommit, commit.id);
    assert.equal(active?.state.latestReview?.verdict, "pass");

    const forged = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "review-complete", reviewId: first.reviewId, result: { verdict: "pass", summary: "forged", findings: [{ id: "x", severity: "info", finding: "x", evidenceRefs: ["fake"] }] } }, runtime);
    assert.equal(forged.ok, false);
    assert.match(forged.error?.message ?? "", /author endpoint does not expose/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("review runtime rejects an evidence-free PASS and converts executor crashes to unresolved once", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-failclosed-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review-fail", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_commit", "cad_submit_for_review"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review", transitions: { finished: { target: "done" } } },
      done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "candidate");
    const empty = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "empty-candidate" });
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "candidate", artifacts: ["candidate.step"] });
    const runtime = new ReviewRuntime(cwd, async () => { throw new Error("crash"); });
    await assert.rejects(runtime.submit(empty.id), /no immutable artifacts/);
    const handle = await runtime.submit(commit.id);
    await assert.rejects(runtime.complete(handle.reviewId, { verdict: "pass", summary: "empty", findings: [] }), /PASS without affirmative evidence/);
    await runtime.waitForIdle(handle.reviewId);
    assert.equal((await runtime.current(handle.reviewId))?.status, "unresolved");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("reviewer authority fixes the immutable subject and enforces twelve probes", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-budget-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review-budget", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_commit", "cad_submit_for_review"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review", transitions: { finished: { target: "done" } } },
      done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "candidate");
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "candidate", artifacts: ["candidate.step"] });
    const runtime = new ReviewRuntime(cwd, async () => new Promise<void>(() => undefined));
    const handle = await runtime.submit(commit.id);
    const wrong = await dispatchSidecarRequest("reviewer", cwd, { schema: 1, op: "load", id: "another-commit", reviewId: handle.reviewId } as any, runtime);
    assert.equal(wrong.ok, false);
    assert.match(wrong.error?.message ?? "", /only its immutable subject/);
    for (let index = 0; index < 12; index += 1) await runtime.admitProbe(handle.reviewId);
    await assert.rejects(runtime.admitProbe(handle.reviewId), /maxProbeCalls=12/);
    runtime.shutdown();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
