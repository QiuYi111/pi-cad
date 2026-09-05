import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { completionGate, dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import { commitWorkspace } from "../src/harness/commit.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { canonicalDigest } from "../src/harness/canonical.ts";
import { legalWorkflowTransitions, transitionRun } from "../src/harness/reducer.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { resolveWorkflowPackage } from "../src/harness/workflow/packages.ts";

test("installed Mechanical packages expose metadata only and compile branchable kernel-generic snapshots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-packages-"));
  try {
    const listed = await handleAgentApi(cwd, { schema: 1, op: "workflow-list" }) as any[];
    assert.deepEqual(listed.map((item) => item.id), ["mechanical.analysis", "mechanical.benchmark", "mechanical.benchmark-author-only", "mechanical.benchmark-build", "mechanical.benchmark-triage", "mechanical.modify", "mechanical.one-shot", "mechanical.parameter-edit"]);
    for (const item of listed) assert.deepEqual(Object.keys(item).sort(), ["description", "id", "tags", "version"]);

    const benchmark = await resolveWorkflowPackage(cwd, "mechanical.benchmark", mechanicalRegistries);
    assert.equal(benchmark.workflow.initialPhase, "grilling");
    assert.equal(benchmark.workflow.phases.requirements_review!.reviewProfile, "mechanical.requirements-review");
    assert.deepEqual(Object.keys(benchmark.workflow.phases.requirements_review!.transitions), ["accepted", "clarification_required", "revise_requirements"]);
    assert.equal(benchmark.workflow.phases.requirements_review!.transitions.clarification_required!.terminalStatus, "waiting_user");
    assert.equal(benchmark.workflow.phases.wait_for_user!.actions.length, 0);
    assert.deepEqual(Object.keys(benchmark.workflow.phases.build!.transitions), ["delivered"]);
    assert.deepEqual(benchmark.workflow.phases.build!.recordObligations.map((item) => item.ref), ["release"]);
    assert.deepEqual(benchmark.workflow.phases.build!.evidenceObligations.map((item) => item.ref), ["candidate-geometry", "candidate-visual"]);
    assert.equal(benchmark.workflow.phases.final_review, undefined);
    assert.equal(benchmark.workflow.phases.release, undefined);
    assert.equal(benchmark.workflow.phases.done!.terminal, true);

    const authorOnly = await resolveWorkflowPackage(cwd, "mechanical.benchmark-author-only", mechanicalRegistries);
    assert.equal(authorOnly.workflow.phases.grilling!.reviewProfile, undefined);
    assert.deepEqual(Object.keys(authorOnly.workflow.phases.grilling!.transitions), ["clarification_required", "interpreted"]);
    assert.equal(authorOnly.workflow.phases.grilling!.transitions.clarification_required!.terminalStatus, "waiting_user");
    assert.equal(authorOnly.workflow.phases.requirements_review, undefined);

    const triage = await resolveWorkflowPackage(cwd, "mechanical.benchmark-triage", mechanicalRegistries);
    assert.equal(triage.workflow.phases.requirements_review!.reviewProfile, "mechanical.requirements-review");
    assert.equal(triage.workflow.phases.requirements_review!.transitions.accepted!.target, "admitted");
    assert.equal(triage.workflow.phases.admitted!.terminal, true);
    assert.equal(Object.values(triage.workflow.phases).some((phase) => phase.actions.includes("cad_build_step")), false);

    const builder = await resolveWorkflowPackage(cwd, "mechanical.benchmark-build", mechanicalRegistries);
    assert.equal(builder.workflow.initialPhase, "build");
    assert.equal(builder.workflow.phases.build!.actions.includes("cad_build_step"), true);
    assert.equal(builder.workflow.phases.build!.reviewProfile, undefined);

    const parameterEdit = await resolveWorkflowPackage(cwd, "mechanical.parameter-edit", mechanicalRegistries);
    assert.equal(parameterEdit.workflow.initialPhase, "adjust");
    assert.equal(parameterEdit.workflow.phases.adjust!.actions.includes("cad_build_step"), true);
    assert.deepEqual(parameterEdit.workflow.phases.adjust!.evidenceObligations.map((item) => item.ref), ["parameter-geometry", "parameter-visual"]);
    assert.deepEqual(Object.keys(parameterEdit.workflow.phases.adjust!.transitions), ["applied"]);

    await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" });
    const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(loaded);
    assert.equal(loaded.workflow.initialPhase, "grilling");
    assert.deepEqual(loaded.workflow.phases.grilling!.recommendedSkills, ["grill-me"]);
    const grillingView = await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any;
    assert.match(grillingView.text, /Use the grill-me skill in this phase/);
    assert.deepEqual(Object.keys(loaded.workflow.phases.concept!.transitions), ["assembly", "single_part"]);
    assert.ok(loaded.workflow.phases.concept!.grants.includes("image_generate"));
    assert.deepEqual(loaded.workflow.phases.concept!.evidenceObligations, [{
      ref: "concept-image", type: "concept_image", closeWith: "codex_generate_image", dependsOn: ["spec"],
    }]);
    assert.equal(loaded.workflow.phases.concept!.actions.includes("cad_build_step"), false);
    assert.equal(loaded.workflow.phases.parts!.actions.includes("cad_build_step"), true);
    assert.deepEqual(loaded.workflow.phases.final_review!.reviewProfile, "mechanical.final-review");
    assert.equal(loaded.workflow.version, "1.0.6");
    assert.deepEqual(Object.keys(loaded.workflow.phases.final_review!.transitions), ["accepted", "revise_architecture_bom", "revise_assembly", "revise_concept", "revise_interface", "revise_parts", "revise_spec"]);
    assert.equal(loaded.workflow.phases.done!.terminal, true);

    const record = (ref: string) => ({ obligationRef: ref, type: "workspace_commit", path: `workspace/commits/${ref}.json`, sha256: "a".repeat(64), workflowHash: loaded.workflow.hash, createdAt: "now" });
    const evidence = (ref: string) => ({ id: ref, obligationRef: ref, type: ref.endsWith("visual") ? "visual" : "geometry", path: `evidence/${ref}`, sha256: "b".repeat(64), workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash, createdAt: "now" });
    const reviewFailure = (state: typeof loaded.state) => ({
      ...state,
      latestReview: {
        id: "review-fail", verdict: "fail", path: "reviews/fail.json", profileId: "mechanical.final-review",
        subjectHash: canonicalDigest({ workflowHash: loaded.workflow.hash, registryContractHash: state.workflow.registryContractHash, phase: state.phase, records: state.records, artifacts: state.artifacts, evidence: state.evidence }),
        workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash,
      },
    });
    const assemblyReview = reviewFailure({
      ...loaded.state, phase: "final_review", phaseHistory: ["grilling", "spec", "concept", "interface", "architecture_bom", "parts", "assembly", "final_review"],
      records: { parts: record("parts"), assembly: record("assembly") },
      evidence: [evidence("assembly-visual"), evidence("assembly-geometry")],
    });
    assert.deepEqual(legalWorkflowTransitions(assemblyReview, loaded.workflow), [
      { event: "revise_architecture_bom", target: "architecture_bom" },
      { event: "revise_assembly", target: "assembly" },
      { event: "revise_concept", target: "concept" },
      { event: "revise_interface", target: "interface" },
      { event: "revise_parts", target: "parts" },
      { event: "revise_spec", target: "spec" },
    ]);
    const revisedAssembly = transitionRun(assemblyReview, loaded.workflow, "revise_assembly");
    assert.equal(revisedAssembly.phase, "assembly");
    assert.equal(revisedAssembly.records.assembly, undefined);
    assert.ok(revisedAssembly.records.parts);
    assert.equal(revisedAssembly.evidence.length, 0);
    assert.equal(revisedAssembly.staleEvidence.length, 2);
    assert.equal(revisedAssembly.latestReview, undefined);

    const partReview = reviewFailure({ ...loaded.state, phase: "final_review", phaseHistory: ["grilling", "spec", "concept", "parts", "final_review"] });
    assert.deepEqual(legalWorkflowTransitions(partReview, loaded.workflow), [
      { event: "revise_concept", target: "concept" },
      { event: "revise_parts", target: "parts" },
      { event: "revise_spec", target: "spec" },
    ]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("one-shot cannot leave concept until a real generated PNG is recorded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-concept-image-"));
  try {
    await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" });
    await handleAgentApi(cwd, { schema: 1, op: "commit", name: "grill" });
    await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "clarified" });
    await handleAgentApi(cwd, { schema: 1, op: "commit", name: "spec" });
    await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "specified" });
    await handleAgentApi(cwd, { schema: 1, op: "commit", name: "concept" });
    await assert.rejects(
      () => handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "single_part" }),
      /concept-image/,
    );
    const image = join(cwd, ".pi", "generated-images", "concept.png");
    await mkdir(join(cwd, ".pi", "generated-images"), { recursive: true });
    await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const recorded = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "image-generated", path: image });
    assert.equal(recorded.ok, true);
    const next = await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "single_part" }) as any;
    assert.equal(next.phase, "parts");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("author-only benchmark can stop headless at wait_for_user without reviewer authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-author-only-clarification-"));
  try {
    await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.benchmark-author-only", interactionMode: "headless" });
    await writeFile(join(cwd, "requirements.md"), "Two placements are materially different. Ask which datum owns the offset.");
    await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "requirements", artifacts: ["requirements.md"] });
    await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "clarification_required" });
    const current = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.equal(current?.state.phase, "wait_for_user");
    assert.equal(current?.state.status, "waiting_user");
    assert.equal(current?.state.latestReview, undefined);
    const gate = await completionGate(cwd);
    assert.equal(gate.complete, true);
    assert.equal(gate.outcome, "clarification_required");
    assert.match(gate.reason, /author identified/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("project-authored package YAML is compiler-admitted and source edits cannot alter a pinned run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-authoring-"));
  const directory = join(cwd, "workflows");
  const path = join(directory, "custom.yaml");
  const source = (purpose: string) => `
schema: 1
id: custom.arbitrary
description: Project-authored arbitrary phase workflow.
tags: [custom, project]
version: 1.0.0
workflow:
  schema: 1
  id: custom.arbitrary
  version: 1.0.0
  parametersSchema: {type: object, additionalProperties: false}
  initialPhase: sketchpad
  phases:
    sketchpad:
      purpose: ${purpose}
      actions: [cad_commit, transition]
      grants: [file_read, transition]
      writeScopes: []
      recordObligations: [{ref: sketch, type: workspace_commit, closeWith: cad_commit}]
      evidenceObligations: []
      contextProviders: [kernel.current-action]
      hooks: []
      transitions: {sealed: {target: archived, requiresPhaseObligations: true}}
    archived:
      purpose: Preserve the result.
      actions: []
      grants: [file_read]
      writeScopes: []
      recordObligations: []
      evidenceObligations: []
      contextProviders: [kernel.current-action]
      hooks: []
      transitions: {}
      terminal: true
`;
  try {
    await mkdir(directory);
    await writeFile(path, source("Original pinned purpose."));
    const listed = await handleAgentApi(cwd, { schema: 1, op: "workflow-list" }) as any[];
    assert.ok(listed.some((item) => item.id === "custom.arbitrary"));
    const started = await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "custom.arbitrary" }) as any;
    const pinnedHash = started.workflowHash;
    assert.equal(started.phase, "sketchpad");

    await writeFile(path, source("A malicious or accidental post-start edit."));
    const current = await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any;
    assert.equal(current.workflowHash, pinnedHash);
    assert.equal(current.purpose, "Original pinned purpose.");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
