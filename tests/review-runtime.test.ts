import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bootstrapAgentApiContracts } from "../src/agent-api/bootstrap.ts";
import { completionGate, dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { ReviewRuntime } from "../src/authority/review-runtime.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { commitWorkspace } from "../src/harness/commit.ts";
import { transitionRun } from "../src/harness/reducer.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("requirements review admits a text contract without geometry or image evidence", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-requirements-review-"));
  try {
    const workflow = compileWorkflowDefinition({
      schema: 1, id: "test/requirements-review", version: "1.0.0", parametersSchema: {}, initialPhase: "requirements_review",
      phases: {
        requirements_review: {
          purpose: "Review interpretation", actions: ["cad_submit_for_review"], grants: ["file_read"], writeScopes: [],
          recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.requirements-review",
          transitions: {
            accepted: { target: "build", reviewVerdicts: ["pass"] },
            clarify: { target: "wait_for_user", reviewVerdicts: ["clarification_required"], terminalStatus: "waiting_user" },
            revise: { target: "requirements", reviewVerdicts: ["fail"] },
          },
        },
        requirements: { purpose: "Repair interpretation", actions: ["transition"], grants: ["file_read", "transition"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { resubmitted: { target: "requirements_review" } } },
        build: { purpose: "Build admitted contract", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
        wait_for_user: { purpose: "Wait for clarification", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {} },
      },
    }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "requirements.md"), "Diameter is 10 mm; do not interpret it as radius.");
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "requirements", artifacts: ["requirements.md"] });
    const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(active);
    await new HarnessRunStoreV7(cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state,
      event: { type: "TestRequirementsMissionInstalled", data: {} },
      payloads: { "context/frame.json": { schema: 1, mission: "Create a cylinder 10 mm in diameter." } },
    }));
    let prompt = "";
    let runtime!: ReviewRuntime;
    runtime = new ReviewRuntime(cwd, async ({ reviewId, prompt: reviewerPrompt }) => {
      prompt = reviewerPrompt;
      const evidence = await runtime.evidence(reviewId);
      assert.equal(evidence.candidate.path, "requirements.md");
      assert.deepEqual(evidence.images, []);
      assert.deepEqual(evidence.dispositions, [
        { verdict: "pass", target: "build", purpose: "Build admitted contract" },
        { verdict: "clarification_required", target: "wait_for_user", purpose: "Wait for clarification" },
        { verdict: "fail", target: "requirements", purpose: "Repair interpretation" },
      ]);
      await runtime.complete(reviewId, { verdict: "pass", target: "build", summary: "faithful interpretation", findings: [] });
    });
    const handle = await runtime.submit(commit.id);
    await runtime.waitForIdle(handle.reviewId);
    assert.match(prompt, /independent requirements reviewer/);
    assert.match(prompt, /diameter\/radius\/side-length confusion/);
    assert.match(prompt, /two or more reasonable readings would produce materially different geometry/);
    assert.match(prompt, /CLARIFICATION_REQUIRED/);
    assert.doesNotMatch(prompt, /cad\.probe\.run/);
    assert.equal((await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries))?.state.phase, "build");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("requirements reviewer can authoritatively stop a headless run for user clarification", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-requirements-clarification-"));
  try {
    const workflow = compileWorkflowDefinition({
      schema: 1, id: "mechanical.benchmark", version: "1.0.0", parametersSchema: {}, initialPhase: "requirements_review",
      phases: {
        requirements_review: {
          purpose: "Review interpretation", actions: ["cad_submit_for_review"], grants: ["file_read"], writeScopes: [],
          recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.requirements-review",
          transitions: {
            accepted: { target: "build", reviewVerdicts: ["pass"] },
            clarification_required: { target: "wait_for_user", reviewVerdicts: ["clarification_required"], terminalStatus: "waiting_user" },
          },
        },
        build: { purpose: "Build", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
        wait_for_user: { purpose: "Wait for user", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {} },
      },
    }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries), interactionMode: "headless" });
    await writeFile(join(cwd, "requirements.md"), "On top may mean coplanar in the sketch or stacked in Z.");
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "requirements", artifacts: ["requirements.md"] });
    const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(active);
    await new HarnessRunStoreV7(cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state,
      event: { type: "TestAmbiguousMissionInstalled", data: {} },
      payloads: { "context/frame.json": { schema: 1, mission: "Put one extruded rectangle on top of another." } },
    }));
    let runtime!: ReviewRuntime;
    runtime = new ReviewRuntime(cwd, async ({ reviewId }) => {
      await runtime.complete(reviewId, {
        verdict: "clarification_required",
        target: "wait_for_user",
        summary: "The extrusion and stacking axes are not uniquely determined.",
        findings: [{ id: "requirements", severity: "warning", finding: "Confirm coplanar profiles versus Z-stacked solids.", evidenceRefs: [] }],
      });
    });
    const handle = await runtime.submit(commit.id);
    await runtime.waitForIdle(handle.reviewId);
    const stopped = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(stopped?.state.phase, "wait_for_user");
    assert.equal(stopped?.state.status, "waiting_user");
    assert.equal(stopped?.state.latestReview?.verdict, "clarification_required");
    const gate = await completionGate(cwd);
    assert.equal(gate.complete, true);
    assert.equal(gate.outcome, "clarification_required");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("review runtime gives the reviewer binary authority and atomically applies its selected disposition", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-runtime-"));
  try {
    const workflow = compileWorkflowDefinition({
      schema: 1, id: "test/review-runtime", version: "1.0.0", parametersSchema: {}, initialPhase: "final_review",
      phases: {
        final_review: {
          purpose: "Independent final review", actions: ["cad_commit", "cad_submit_for_review", "transition"], grants: ["file_read", "transition"], writeScopes: [],
          recordObligations: [{ ref: "concept", type: "workspace_commit", closeWith: "cad_commit" }], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review",
          transitions: { accepted: { target: "done", reviewVerdicts: ["pass"] } },
        },
        done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
      },
    }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "immutable-candidate");
    await writeFile(join(cwd, "review.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(join(cwd, "concept.png"), Buffer.from("89504e470d0a1a0a01020304", "hex"));
    await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "concept", artifacts: [{ path: "concept.png", role: "committed-concept-image" }] });
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "final-candidate", artifacts: [{ path: "candidate.step", role: "authoritative-candidate-design" }] });
    const activeBeforeReview = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(activeBeforeReview);
    await new HarnessRunStoreV7(cwd, activeBeforeReview.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, contextRefs: { ...(state.contextRefs ?? {}), mandatoryImageIso: "review.png" } },
      event: { type: "TestReviewImageInstalled", data: {} },
      payloads: { "context/frame.json": { schema: 1, mission: "Design a dependable test candidate." } },
    }));
    let launches = 0;
    let reviewerPrompt = "";
    let reviewerStoppedAfterVerdict = false;
    let runtime!: ReviewRuntime;
    const expectedResult = { verdict: "pass" as const, target: "done", summary: "independent engineering review passes", findings: [] };
    runtime = new ReviewRuntime(cwd, async ({ reviewId, prompt, signal }) => {
      launches += 1;
      reviewerPrompt = prompt;
      const evidence = await runtime.evidence(reviewId);
      assert.deepEqual(evidence.dispositions, [{ verdict: "pass", target: "done", purpose: "Done" }]);
      assert.deepEqual(evidence.images.map(({ source, obligationRef }) => ({ source, obligationRef })), [
        { source: "committed-design-intent", obligationRef: "concept" },
        { source: "candidate-view", obligationRef: undefined },
      ]);
      assert.match(evidence.images[0]!.evidenceRef, /^design-intent:concept:/);
      await runtime.complete(reviewId, expectedResult);
      reviewerStoppedAfterVerdict = signal.aborted;
    });
    const first = await runtime.submit(commit.id);
    await runtime.waitForIdle(first.reviewId);
    assert.equal(launches, 1);
    assert.equal(reviewerStoppedAfterVerdict, true);
    assert.match(reviewerPrompt, /cad\.review\.inspect\(\)/);
    assert.match(reviewerPrompt, /original user's request/);
    assert.match(reviewerPrompt, /author's own committed design intent and artifacts, including concept images/);
    assert.match(reviewerPrompt, /without prescribing a particular architecture/);
    assert.match(reviewerPrompt, /Form and execute your own review plan/);
    assert.match(reviewerPrompt, /You own the review decision/);
    assert.match(reviewerPrompt, /PASS is an affirmative engineering judgment/);
    assert.match(reviewerPrompt, /Do not infer material quantitative, kinematic, assembly, strength, manufacturability, or fit claims from appearance alone/);
    assert.match(reviewerPrompt, /A claim that you can inspect, measure, or reason about from the immutable candidate is yours to evaluate/);
    assert.match(reviewerPrompt, /context\['candidate'\].*authoritative ArtifactRef ready for cad\.probe\.run/);
    assert.match(reviewerPrompt, /Missing or weak author-supplied proof is not itself a design defect/);
    assert.match(reviewerPrompt, /transfers the inspection work to you/);
    assert.match(reviewerPrompt, /Do not request more external input and do not return an inconclusive verdict/);
    assert.match(reviewerPrompt, /choose the phase where the defect should actually be repaired/);
    assert.match(reviewerPrompt, /Only runtime failure may produce UNRESOLVED/);
    assert.match(reviewerPrompt, /context\.dispositions/);
    assert.doesNotMatch(reviewerPrompt, /maxProbeCalls|maxTurns|noCompaction/);
    assert.doesNotMatch(reviewerPrompt, /bounding.box|solid count|coaxiality|BOM/);
    const current = await runtime.current(first.reviewId);
    assert.equal(current?.status, "pass");
    assert.deepEqual(current?.result, expectedResult);
    assert.deepEqual((await runtime.watch())?.result, expectedResult);
    const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(active?.state.latestReview?.subjectCommit, commit.id);
    assert.equal(active?.state.latestReview?.verdict, "pass");
    assert.equal(active?.state.phase, "done");

    const forged = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "review-complete", reviewId: first.reviewId, result: { verdict: "pass", target: "done", summary: "forged", findings: [] } }, runtime);
    assert.equal(forged.ok, false);
    assert.match(forged.error?.message ?? "", /author endpoint does not expose/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("review runtime reserves unresolved for runtime failure and retries the unchanged candidate", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-failclosed-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review-fail", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_commit", "cad_submit_for_review"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review", transitions: { finished: { target: "done", reviewVerdicts: ["pass"] } } },
      done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "candidate");
    const empty = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "empty-candidate" });
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "candidate", artifacts: ["candidate.step"] });
    let launches = 0;
    const runtime = new ReviewRuntime(cwd, async () => { launches += 1; throw new Error("crash"); });
    await assert.rejects(runtime.submit(empty.id), /no immutable artifacts/);
    const handle = await runtime.submit(commit.id);
    await runtime.waitForIdle(handle.reviewId);
    const current = await runtime.current(handle.reviewId);
    assert.equal(current?.status, "unresolved");
    assert.match(current?.result?.summary ?? "", /reviewer failed safely: crash/);
    assert.equal(current?.result?.findings[0]?.id, "reviewer-crash");
    const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(active?.state.phase, "review");
    assert.equal(active?.state.latestReview, undefined);
    const retry = await runtime.submit(commit.id);
    assert.notEqual(retry.reviewId, handle.reviewId);
    await runtime.waitForIdle(retry.reviewId);
    assert.equal(launches, 2);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a restarted sidecar recovers an orphaned running reviewer and relaunches the unchanged candidate", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-restart-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review-restart", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_commit", "cad_submit_for_review"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review", transitions: { finished: { target: "done", reviewVerdicts: ["pass"] } } },
      done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "candidate");
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "candidate", artifacts: ["candidate.step"] });
    const abandoned = new ReviewRuntime(cwd, async () => new Promise<void>(() => undefined));
    const first = await abandoned.submit(commit.id);
    abandoned.shutdown();

    let relaunched = 0;
    const restarted = new ReviewRuntime(cwd, async () => { relaunched += 1; throw new Error("expected test stop"); });
    const retry = await restarted.submit(commit.id);
    assert.notEqual(retry.reviewId, first.reviewId);
    await restarted.waitForIdle(retry.reviewId);
    assert.equal(relaunched, 1);
    assert.equal((await restarted.current(first.reviewId))?.result?.findings[0]?.id, "reviewer-interrupted");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("reviewer authority fixes the subject, exposes legal dispositions, and leaves probes unbounded", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-budget-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review-budget", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
      review: { purpose: "Review", actions: ["cad_commit", "cad_submit_for_review"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review", transitions: { accepted: { target: "done", reviewVerdicts: ["pass"] }, revise: { target: "rework", reviewVerdicts: ["fail"] } } },
      rework: { purpose: "Repair the reviewer-selected defect", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {} },
      done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "candidate");
    await writeFile(join(cwd, "review.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const commit = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "candidate", artifacts: ["candidate.step"] });
    const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(active);
    await new HarnessRunStoreV7(cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, contextRefs: { ...(state.contextRefs ?? {}), mandatoryImageIso: "review.png" } },
      event: { type: "TestReviewImageInstalled", data: {} },
      payloads: { "context/frame.json": { schema: 1, mission: "Review the immutable candidate." } },
    }));
    const runtime = new ReviewRuntime(cwd, async () => new Promise<void>(() => undefined));
    const handle = await runtime.submit(commit.id);
    const wrong = await dispatchSidecarRequest("reviewer", cwd, { schema: 1, op: "load", id: "another-commit", reviewId: handle.reviewId } as any, runtime);
    assert.equal(wrong.ok, false);
    assert.match(wrong.error?.message ?? "", /only its immutable subject/);
    const authorEvidence = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "review-evidence", reviewId: handle.reviewId } as any, runtime);
    assert.equal(authorEvidence.ok, false);
    assert.match(authorEvidence.error?.message ?? "", /author endpoint does not expose/);
    const reviewerEvidence = await dispatchSidecarRequest("reviewer", cwd, { schema: 1, op: "review-evidence", reviewId: handle.reviewId } as any, runtime);
    assert.equal(reviewerEvidence.ok, true);
    assert.equal((reviewerEvidence.result as any).images.length, 1);
    assert.deepEqual((reviewerEvidence.result as any).dispositions, [
      { verdict: "pass", target: "done", purpose: "Done" },
      { verdict: "fail", target: "rework", purpose: "Repair the reviewer-selected defect" },
    ]);
    for (let index = 0; index < 64; index += 1) await runtime.admitProbe(handle.reviewId);
    await runtime.complete(handle.reviewId, { verdict: "fail", target: "rework", summary: "repair at the source of the defect", findings: [] });
    const activeAfter = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(activeAfter?.state.phase, "rework");
    runtime.shutdown();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("the same authoritative candidate cannot buy a new reviewer by changing attachments or implementation records", async () => {
  bootstrapAgentApiContracts();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-candidate-idempotency-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/review-candidate-idempotency", version: "1.0.0", parametersSchema: {}, initialPhase: "parts", phases: {
      parts: {
        purpose: "Author candidate", actions: ["cad_build_step", "cad_commit", "transition"], grants: ["file_read", "model_build", "transition"], writeScopes: [],
        recordObligations: [{ ref: "parts", type: "workspace_commit", closeWith: "cad_commit" }], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [],
        transitions: { submitted: { target: "final_review", requiresPhaseObligations: true } },
      },
      final_review: {
        purpose: "Review candidate", actions: ["cad_submit_for_review"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review",
        transitions: { accepted: { target: "done", reviewVerdicts: ["pass"] }, revise_parts: { target: "parts", reviewVerdicts: ["fail"], invalidate: ["parts"] } },
      },
      done: { purpose: "Done", actions: [], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await writeFile(join(cwd, "candidate.step"), "same-authoritative-geometry");
    await writeFile(join(cwd, "report-1.json"), "{\"attempt\":1}");
    await writeFile(join(cwd, "review.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const installFrame = async () => {
      const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
      assert.ok(active);
      await new HarnessRunStoreV7(cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
        state: { ...state, contextRefs: { ...(state.contextRefs ?? {}), mandatoryImageIso: "review.png" } },
        event: { type: "TestReviewImageInstalled", data: {} },
        payloads: { "context/frame.json": { schema: 1, mission: "Review one immutable STEP." } },
      }));
    };
    await installFrame();
    const enterReview = async (report: string) => {
      await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "parts" });
      const handoff = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "review-candidate", artifacts: ["candidate.step", report] });
      const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
      assert.ok(active);
      await new HarnessRunStoreV7(cwd, active.state.runId).mutate(mechanicalRegistries, (loaded) => ({
        state: transitionRun(loaded.state, loaded.workflow, "submitted"), event: { type: "TestEnteredReview", data: {} },
      }));
      return handoff;
    };

    let launches = 0;
    let runtime!: ReviewRuntime;
    runtime = new ReviewRuntime(cwd, async ({ reviewId }) => {
      launches += 1;
      await runtime.complete(reviewId, { verdict: "fail", target: "parts", summary: "candidate geometry must change", findings: [] });
    });
    const firstCommit = await enterReview("report-1.json");
    const first = await runtime.submit(firstCommit.id);
    await runtime.waitForIdle(first.reviewId);
    assert.equal((await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries))?.state.phase, "parts");

    await writeFile(join(cwd, "report-2.json"), "{\"attempt\":2,\"moreProof\":true}");
    const secondCommit = await enterReview("report-2.json");
    const second = await runtime.submit(secondCommit.id);
    assert.equal(second.reviewId, first.reviewId);
    assert.equal(second.status, "fail");
    assert.equal(launches, 1);
    assert.equal((await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries))?.state.phase, "parts");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
