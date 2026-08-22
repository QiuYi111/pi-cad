import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runFinalReviewPreflight } from "../src/control/final-review/preflight.ts";
import { collectReviewerEvidenceIndex } from "../src/control/final-review/evidence-index.ts";
import { validateFinalReviewResult } from "../src/control/final-review/reviewer.ts";
import { aggregateReviewVotes, type StoredReviewVote } from "../src/control/final-review/voting.ts";
import { requirementsRevisionAuthorized, registerControlTools, type ControllerDeps } from "../src/core/controller.ts";
import {
  acceptCandidate,
  commitPlan,
  commitRequirements,
  route,
  validateAcceptanceAssertions,
} from "../src/core/state-machine.ts";
import { finalSubmissionAllowed } from "../src/core/policies.ts";
import type { CadRequirements, CadRunState, FinalReviewResult } from "../src/shared/protocol.ts";
import { CadProjectStore, hashRecord, sha256File } from "../src/shared/store.ts";

const quickRoute = {
  objective: "design",
  lineage: "greenfield",
  structure: "part",
  maturity: "prototype",
} as const;

test("CADTestBench headless runs enable the independent final reviewer", () => {
  const runner = readFileSync(join(process.cwd(), "benchmarks", "cadtestbench", "run.mjs"), "utf-8");
  assert.match(
    runner,
    /PI_CAD_HEADLESS:\s*"1"[\s\S]*?PI_CAD_FINAL_REVIEWER:\s*"1"/,
  );
  assert.match(runner, /tarExtract\(vaultTarPath\(e\.tar\), preloadDir\)/);
  assert.doesNotMatch(runner, /tarExtract\(vaultTarPath\(e\.tar\), join\(preloadDir, key\)\)/);
});

function requirements(expected = 10): CadRequirements {
  return {
    goal: "box with a controlled X extent",
    deliverables: ["STEP"],
    must: [`overall X extent is ${expected} mm`],
    assertions: [{
      id: "A-x",
      mustRef: "M1",
      statement: `Overall X extent is ${expected} mm`,
      binding: { subject: "final body", quantity: "overall extent", direction: "X" },
      expectation: { kind: "exact", value: expected, unit: "mm", tolerance: 0.001 },
      canonicalCheck: { field: "bbox.x" },
    }],
    preferences: [],
    assumptions: [],
    openUnknowns: [],
  };
}

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

test("requirements revision authority is one-shot input bound to the exact proposed contract hash", () => {
  const previous = requirements(10);
  const routed = route(null, quickRoute, "test");
  assert.equal(routed.ok, true);
  if (!routed.ok) throw new Error("unreachable");
  const state: CadRunState = {
    ...routed.state,
    interactionMode: "headless",
    currentSourceHash: "source-a",
    currentArtifactHash: "artifact-a",
  };
  const revisionHash = hashRecord({ ...previous, goal: "revised goal" });
  assert.equal(requirementsRevisionAuthorized(state, revisionHash, undefined), false);
  const authorized = {
    ...state,
    requirementsAuthorityToken: "once-token",
    requirementsAuthorityHash: revisionHash,
  };
  assert.equal(requirementsRevisionAuthorized(authorized, revisionHash, "wrong-token"), false);
  assert.equal(requirementsRevisionAuthorized(authorized, "different-hash", "once-token"), false);
  assert.equal(requirementsRevisionAuthorized(authorized, revisionHash, "once-token"), true);
});

test("cad_commit_requirements uses exact one-shot authority and headless cannot revise", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-contract-auth-"));
  try {
    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "contract-auth-run" });
    const initial = requirements(10);
    const routed = route(null, quickRoute, "test");
    assert.equal(routed.ok, true);
    if (!routed.ok) throw new Error("unreachable");
    const committed = commitRequirements(routed.state, initial);
    assert.equal(committed.ok, true);
    if (!committed.ok) throw new Error("unreachable");
    await store.save({ ...committed.state, runId: "contract-auth-run", phase: "build" });
    await store.run("contract-auth-run").writeRecord("requirements", initial);

    const tools = new Map<string, any>();
    const pi = { registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
    registerControlTools(pi, {
      pi,
      persist: async (_pi, targetStore, next, events) => {
        await targetStore.save(next);
        for (const event of events) await targetStore.appendEvent(event.type, event.data);
      },
      runBaselineAuto: async () => { throw new Error("unused"); },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
    });
    const ctx = { cwd } as ExtensionContext;
    const beforeInvalid = await store.load();
    const invalid = await tools.get("cad_commit_requirements").execute(
      "r0", { ...requirements(11), goal: "" }, undefined, undefined, ctx,
    );
    assert.match(invalid.content[0].text, /invalid requirements record/);
    const afterInvalid = await store.load();
    assert.equal(afterInvalid?.status, beforeInvalid?.status);
    assert.equal(afterInvalid?.phase, beforeInvalid?.phase);
    assert.equal(afterInvalid?.pendingRequirementsRevision, undefined);

    const revision = requirements(11);
    const requested = await tools.get("cad_commit_requirements").execute(
      "r1", revision, undefined, undefined, ctx,
    );
    assert.match(requested.content[0].text, /immutable/);
    const pending = await store.load();
    assert.equal(pending?.pendingRequirementsRevision?.hash, hashRecord(revision));

    await store.save({
      ...pending!,
      requirementsAuthorityToken: "approved-once",
      requirementsAuthorityHash: hashRecord(revision),
    });
    const applied = await tools.get("cad_commit_requirements").execute(
      "r2", { ...revision, authorityToken: "approved-once" }, undefined, undefined, ctx,
    );
    assert.match(applied.content[0].text, /Requirements committed/);
    const consumed = await store.load();
    assert.equal(consumed?.requirementsAuthorityToken, null);
    assert.equal(consumed?.pendingRequirementsRevision, null);
    assert.equal(consumed?.requirementsVersion, hashRecord(revision));

    await store.save({
      ...consumed!,
      phase: "review",
      status: "active",
      interactionMode: "headless",
    });
    const headlessAttempt = requirements(12);
    const blocked = await tools.get("cad_commit_requirements").execute(
      "r3", headlessAttempt, undefined, undefined, ctx,
    );
    assert.match(blocked.content[0].text, /HEADLESS run is BLOCKED_USER/);
    const blockedState = await store.load();
    assert.equal(blockedState?.status, "blocked_user");
    const frozenRecord = JSON.parse(
      readFileSync(join(store.run("contract-auth-run").recordsDir, "requirements.json"), "utf-8"),
    );
    assert.equal(hashRecord(frozenRecord), hashRecord(revision));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function seedReview(cwd: string, expected = 10, observed = 10) {
  const store = new CadProjectStore(cwd);
  await store.createRun({ runId: "review-run" });
  const req = requirements(expected);
  const routed = route(null, quickRoute, "test");
  assert.ok(routed.ok);
  if (!routed.ok) throw new Error(routed.reason);
  const committed = commitRequirements({ ...routed.state, runId: "review-run" }, req);
  assert.ok(committed.ok);
  if (!committed.ok) throw new Error(committed.reason);
  const planned = commitPlan(committed.state, {
    summary: "box",
    protected: [],
    plannedChanges: [],
    interfaces: [],
    datums: [],
    reviewPlan: [],
  });
  assert.ok(planned.ok);
  if (!planned.ok) throw new Error(planned.reason);
  const source = "models/box.py";
  const artifact = "build/box.step";
  const visual = ".pi-cad/runs/review-run/evidence/visual/iso.png";
  const geometry = ".pi-cad/runs/review-run/evidence/geometry/box.json";
  for (const path of [source, artifact, visual, geometry]) {
    const parent = join(cwd, path, "..");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(parent, { recursive: true }));
  }
  writeFileSync(join(cwd, source), "# box\n");
  writeFileSync(join(cwd, artifact), "STEP-DATA\n");
  writeFileSync(join(cwd, visual), "PNG-DATA\n");
  writeFileSync(join(cwd, geometry), JSON.stringify({
    units: "mm",
    bbox: { x: observed, y: 2, z: 1 },
    volume: observed * 2,
    surfaceArea: 1,
    solidCount: 1,
    occurrenceCount: 1,
    cylinders: [],
  }));
  const candidate = acceptCandidate(
    planned.state,
    {
      label: "box-v1",
      sources: [source],
      sourceHashes: { [source]: await sha256File(join(cwd, source)) },
      sourcePath: source,
      artifactPath: artifact,
    },
    await sha256File(join(cwd, artifact)),
  );
  assert.ok(candidate.ok);
  if (!candidate.ok) throw new Error(candidate.reason);
  const state: CadRunState = {
    ...candidate.state,
    evidence: [
      {
        id: "visual-1",
        kind: "visual",
        tool: "cad_inspect_visual",
        artifactHash: candidate.state.currentArtifactHash!,
        paths: [visual],
        artifacts: [{ path: visual, sha256: await sha256File(join(cwd, visual)) }],
        createdAt: new Date().toISOString(),
      },
      {
        id: "geometry-1",
        kind: "geometry",
        tool: "cad_inspect_geometry",
        artifactHash: candidate.state.currentArtifactHash!,
        paths: [geometry],
        artifacts: [{ path: geometry, sha256: await sha256File(join(cwd, geometry)) }],
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await store.save(state);
  await store.writeRecord("requirements", req);
  return { store, state, req };
}

test("assertion contract covers every Must before implementation", () => {
  assert.match(validateAcceptanceAssertions(["a", "b"], []), /cover every Must/);
  assert.match(validateAcceptanceAssertions(["a", "b"], [{
    id: "A1",
    mustRef: "M1",
    statement: "a",
    binding: { subject: "body", quantity: "a" },
    expectation: { kind: "boolean", expected: true },
  }]), /M2/);
  assert.match(validateAcceptanceAssertions(["x"], [{
    id: "A-x",
    mustRef: "M1",
    statement: "global X extent is 10 mm",
    binding: { subject: "body", quantity: "extent", direction: "global X" },
    expectation: { kind: "exact", value: 10, unit: "mm" },
  }]), /omits canonicalCheck bbox\.x/);
  assert.match(validateAcceptanceAssertions(["x"], [{
    id: "A-x",
    mustRef: "M1",
    statement: "global X extent is 10 mm",
    binding: { subject: "body", quantity: "extent", direction: "global X axis" },
    expectation: { kind: "exact", value: 10, unit: "mm" },
    canonicalCheck: { field: "bbox.y" },
  }]), /binds global X but canonicalCheck uses bbox\.y/);
});

test("deterministic preflight reads bare geometry payload and blocks a contradiction", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-preflight-"));
  try {
    const { state, req } = await seedReview(cwd, 0.52105, 0.260525);
    const result = await runFinalReviewPreflight(cwd, state, req);
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.contradictions[0]?.assertionId, "A-x");
    assert.equal(result.contradictions[0]?.observed, 0.260525);
    assert.equal(result.artifactIntegrity.evidenceRef, "preflight:artifact-integrity");
    assert.match(result.artifactIntegrity.finding, /source contents are intentionally withheld/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reviewer evidence index does not expose generating source", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-review-source-blind-"));
  try {
    const { state } = await seedReview(cwd);
    const index = collectReviewerEvidenceIndex(state);
    assert.equal(index.items.some((item) => item.paths.includes(state.currentSourcePath!)), false);
    assert.equal(index.items.some((item) => item.paths.some((path) => path.endsWith(".py"))), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("review output validation is fail-closed", () => {
  const req = requirements();
  const pass: FinalReviewResult = {
    verdict: "pass",
    assertionChecks: [{ assertionId: "A-x", verdict: "pass", finding: "measured", evidenceRefs: ["probe:1"] }],
    semanticObjections: [],
    summary: "pass",
  };
  assert.equal(validateFinalReviewResult(pass, req, new Set(["probe:1"])), null);
  assert.match(validateFinalReviewResult({ ...pass, assertionChecks: [{ ...pass.assertionChecks[0]!, evidenceRefs: [] }] }, req, new Set()), /requires evidence/);
  assert.match(validateFinalReviewResult({ ...pass, assertionChecks: [{ ...pass.assertionChecks[0]!, evidenceRefs: ["unknown"] }] }, req, new Set()), /unknown evidence ref/);
});

test("same-source natural retries use a recent directional majority", () => {
  const key = {
    sourceHash: sha("source-a"),
    requirementsHash: sha("requirements-a"),
    assertionsHash: sha("assertions-a"),
  };
  const vote = (verdict: "pass" | "fail" | "unresolved", path: string): StoredReviewVote => ({
    ...key,
    verdict,
    path,
  });
  const tied = aggregateReviewVotes(key, "pass", [vote("fail", "review-001.json")]);
  assert.equal(tied.verdict, "unresolved");
  assert.deepEqual({ pass: tied.pass, fail: tied.fail }, { pass: 1, fail: 1 });

  const majority = aggregateReviewVotes(key, "pass", [
    vote("pass", "review-002.json"),
    vote("fail", "review-001.json"),
  ]);
  assert.equal(majority.verdict, "pass");
  assert.deepEqual({ pass: majority.pass, fail: majority.fail }, { pass: 2, fail: 1 });
});

test("review votes reset when source or acceptance contract changes", () => {
  const key = {
    sourceHash: sha("source-a"),
    requirementsHash: sha("requirements-a"),
    assertionsHash: sha("assertions-a"),
  };
  const history: StoredReviewVote[] = [{
    ...key,
    sourceHash: sha("source-b"),
    verdict: "fail",
    path: "different-source.json",
  }, {
    ...key,
    requirementsHash: sha("requirements-b"),
    verdict: "fail",
    path: "different-requirements.json",
  }, {
    ...key,
    assertionsHash: sha("assertions-b"),
    verdict: "fail",
    path: "different-assertions.json",
  }];
  const aggregate = aggregateReviewVotes(key, "pass", history);
  assert.equal(aggregate.verdict, "pass");
  assert.deepEqual({ pass: aggregate.pass, fail: aggregate.fail }, { pass: 1, fail: 0 });
});

test("UNRESOLVED is retained as fail-closed without casting a directional vote", () => {
  const key = {
    sourceHash: sha("source-a"),
    requirementsHash: sha("requirements-a"),
    assertionsHash: sha("assertions-a"),
  };
  const aggregate = aggregateReviewVotes(key, "unresolved", [{
    ...key,
    verdict: "pass",
    path: "review-001.json",
  }]);
  assert.equal(aggregate.verdict, "unresolved");
  assert.deepEqual({ pass: aggregate.pass, fail: aggregate.fail }, { pass: 1, fail: 0 });
});

test("final submission visibility derives from the compiled accepted target", () => {
  const previous = process.env.PI_CAD_FINAL_REVIEWER;
  process.env.PI_CAD_FINAL_REVIEWER = "1";
  try {
    const review = { route: quickRoute, phase: "review" } as CadRunState;
    assert.equal(finalSubmissionAllowed(review), true);
    const releaseReview = {
      route: { ...quickRoute, maturity: "release" },
      phase: "review",
    } as CadRunState;
    assert.equal(finalSubmissionAllowed(releaseReview), false);
    assert.equal(finalSubmissionAllowed({ ...releaseReview, phase: "final_review" }), true);
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_FINAL_REVIEWER;
    else process.env.PI_CAD_FINAL_REVIEWER = previous;
  }
});

test("cad_submit_for_review PASS is the only enabled final closure path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-submit-"));
  const previous = process.env.PI_CAD_FINAL_REVIEWER;
  process.env.PI_CAD_FINAL_REVIEWER = "1";
  try {
    const { store, state } = await seedReview(cwd);
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
    const deps: ControllerDeps = {
      pi,
      persist: async (_pi, targetStore, next, events) => {
        await targetStore.save(next);
        for (const event of events) await targetStore.appendEvent(event.type, event.data);
      },
      runBaselineAuto: async () => { throw new Error("unused"); },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
      reviewerRunner: { run: async () => ({
        result: {
          verdict: "pass",
          assertionChecks: [{ assertionId: "A-x", verdict: "pass", finding: "bbox.x = 10", evidenceRefs: ["preflight:A-x"] }],
          semanticObjections: [],
          summary: "all assertions pass",
        },
        evidenceIndex: { items: [], visualPaths: [], snapshotHash: sha("snapshot") },
        probeCalls: 0,
        usage: [],
        reviewerModel: "fake/reviewer",
        probeEvidence: [],
      }) },
    };
    registerControlTools(pi, deps);
    const ctx = { cwd } as ExtensionContext;
    const direct = await tools.get("cad_transition").execute("t1", { event: "accepted", note: "self review" }, undefined, undefined, ctx);
    assert.match(direct.content[0].text, /requires cad_submit_for_review/);
    const submitted = await tools.get("cad_submit_for_review").execute("t2", {}, undefined, undefined, ctx);
    assert.match(submitted.content[0].text, /PASS/);
    const ready = await store.load();
    assert.equal(ready?.phase, "ready");
    assert.equal(ready?.finalReview?.verdict, "pass");
    assert.ok(ready?.finalReview?.path && existsSync(join(cwd, ready.finalReview.path)));
    assert.equal(state.phase, "review");
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_FINAL_REVIEWER;
    else process.env.PI_CAD_FINAL_REVIEWER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cad_submit_for_review aggregates natural same-source retries before closing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-submit-votes-"));
  const previous = process.env.PI_CAD_FINAL_REVIEWER;
  process.env.PI_CAD_FINAL_REVIEWER = "1";
  try {
    const { store } = await seedReview(cwd);
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
    const verdicts: Array<"pass" | "fail"> = ["fail", "pass", "pass"];
    registerControlTools(pi, {
      pi,
      persist: async (_pi, targetStore, next, events) => {
        await targetStore.save(next);
        for (const event of events) await targetStore.appendEvent(event.type, event.data);
      },
      runBaselineAuto: async () => { throw new Error("unused"); },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
      reviewerRunner: { run: async () => {
        const verdict = verdicts.shift();
        if (!verdict) throw new Error("unexpected extra review");
        return {
          result: {
            verdict,
            assertionChecks: [{
              assertionId: "A-x",
              verdict,
              finding: verdict === "pass" ? "bbox.x = 10" : "semantic concern",
              evidenceRefs: ["preflight:A-x"],
            }],
            semanticObjections: [],
            summary: verdict,
          },
          evidenceIndex: { items: [], visualPaths: [], snapshotHash: sha(`snapshot-${verdicts.length}`) },
          probeCalls: 0,
          usage: [],
          reviewerModel: "fake/reviewer",
          probeEvidence: [],
        };
      } },
    });
    const submit = tools.get("cad_submit_for_review");
    const ctx = { cwd } as ExtensionContext;

    const first = await submit.execute("vote-1", {}, undefined, undefined, ctx);
    assert.match(first.content[0].text, /review FAIL \(current vote FAIL; recent votes PASS 0, FAIL 1\)/);
    let state = await store.load();
    assert.equal(state?.phase, "build");

    await store.save({ ...state!, phase: "review" });
    const second = await submit.execute("vote-2", {}, undefined, undefined, ctx);
    assert.match(second.content[0].text, /review UNRESOLVED \(current vote PASS; recent votes PASS 1, FAIL 1\)/);
    state = await store.load();
    assert.equal(state?.phase, "build");

    await store.save({ ...state!, phase: "review" });
    const third = await submit.execute("vote-3", {}, undefined, undefined, ctx);
    assert.match(third.content[0].text, /review PASS \(current vote PASS; recent votes PASS 2, FAIL 1\)/);
    state = await store.load();
    assert.equal(state?.phase, "ready");
    assert.equal(state?.finalReview?.individualVerdict, "pass");
    assert.equal(state?.finalReview?.verdict, "pass");

    const reports = await store.listReviewsNewestFirst<any>();
    assert.equal(reports.length, 3);
    const latest = JSON.parse(readFileSync(reports[0]!.path, "utf-8"));
    assert.equal(latest.result.verdict, "pass");
    assert.deepEqual(
      { verdict: latest.aggregate.verdict, pass: latest.aggregate.pass, fail: latest.aggregate.fail },
      { verdict: "pass", pass: 2, fail: 1 },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_FINAL_REVIEWER;
    else process.env.PI_CAD_FINAL_REVIEWER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("deterministic preflight contradiction automatically returns to editable source phase", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-preflight-regress-"));
  const previous = process.env.PI_CAD_FINAL_REVIEWER;
  process.env.PI_CAD_FINAL_REVIEWER = "1";
  try {
    const { store } = await seedReview(cwd, 10, 5);
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
    registerControlTools(pi, {
      pi,
      persist: async (_pi, targetStore, next, events) => {
        await targetStore.save(next);
        for (const event of events) await targetStore.appendEvent(event.type, event.data);
      },
      runBaselineAuto: async () => { throw new Error("unused"); },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
      reviewerRunner: { run: async () => { throw new Error("reviewer must not start"); } },
    });
    const submitted = await tools.get("cad_submit_for_review").execute(
      "t-preflight-fail",
      {},
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
    assert.match(submitted.content[0].text, /deterministic preflight/);
    assert.match(submitted.content[0].text, /editable BUILD/);
    const state = await store.load();
    assert.equal(state?.phase, "build");
    assert.equal(state?.mutationPolicy, "source_only");
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_FINAL_REVIEWER;
    else process.env.PI_CAD_FINAL_REVIEWER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reviewer crash persists UNRESOLVED and automatically returns to editable source phase", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-review-crash-"));
  const previous = process.env.PI_CAD_FINAL_REVIEWER;
  process.env.PI_CAD_FINAL_REVIEWER = "1";
  try {
    const { store } = await seedReview(cwd);
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
    registerControlTools(pi, {
      pi,
      persist: async (_pi, targetStore, next, events) => {
        await targetStore.save(next);
        for (const event of events) await targetStore.appendEvent(event.type, event.data);
      },
      runBaselineAuto: async () => { throw new Error("unused"); },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
      reviewerRunner: { run: async () => { throw new Error("provider unavailable"); } },
    });
    const submitted = await tools.get("cad_submit_for_review").execute(
      "t-crash",
      {},
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
    assert.match(submitted.content[0].text, /UNRESOLVED/);
    assert.match(submitted.content[0].text, /editable BUILD/);
    const review = await store.load();
    assert.equal(review?.phase, "build");
    assert.equal(review?.mutationPolicy, "source_only");
    assert.equal(review?.finalReview?.verdict, "unresolved");
    assert.ok(review?.finalReview?.path && existsSync(join(cwd, review.finalReview.path)));
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_FINAL_REVIEWER;
    else process.env.PI_CAD_FINAL_REVIEWER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
