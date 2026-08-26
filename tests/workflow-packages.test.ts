import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleAgentApi } from "../src/agent-api/handlers.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { canonicalDigest } from "../src/harness/canonical.ts";
import { legalWorkflowTransitions, transitionRun } from "../src/harness/reducer.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";

test("installed Mechanical packages expose metadata only and compile branchable kernel-generic snapshots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-packages-"));
  try {
    const listed = await handleAgentApi(cwd, { schema: 1, op: "workflow-list" }) as any[];
    assert.deepEqual(listed.map((item) => item.id), ["mechanical.analysis", "mechanical.modify", "mechanical.one-shot"]);
    for (const item of listed) assert.deepEqual(Object.keys(item).sort(), ["description", "id", "tags", "version"]);

    await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" });
    const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.ok(loaded);
    assert.equal(loaded.workflow.initialPhase, "grill");
    assert.deepEqual(Object.keys(loaded.workflow.phases.concept!.transitions), ["assembly", "single_part"]);
    assert.ok(loaded.workflow.phases.concept!.grants.includes("image_generate"));
    assert.equal(loaded.workflow.phases.concept!.actions.includes("cad_build_step"), false);
    assert.equal(loaded.workflow.phases.parts!.actions.includes("cad_build_step"), true);
    assert.deepEqual(loaded.workflow.phases.final_review!.reviewProfile, "mechanical.final-review");
    assert.equal(loaded.workflow.version, "1.0.1");
    assert.deepEqual(Object.keys(loaded.workflow.phases.final_review!.transitions), ["accepted", "revise_assembly", "revise_single_part"]);
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
      ...loaded.state, phase: "final_review", phaseHistory: ["grill", "spec", "concept", "interface", "architecture_bom", "parts", "assembly", "final_review"],
      records: { parts: record("parts"), assembly: record("assembly") },
      evidence: [evidence("assembly-visual"), evidence("assembly-geometry")],
    });
    assert.deepEqual(legalWorkflowTransitions(assemblyReview, loaded.workflow), [{ event: "revise_assembly", target: "assembly" }]);
    const revisedAssembly = transitionRun(assemblyReview, loaded.workflow, "revise_assembly");
    assert.equal(revisedAssembly.phase, "assembly");
    assert.equal(revisedAssembly.records.assembly, undefined);
    assert.ok(revisedAssembly.records.parts);
    assert.equal(revisedAssembly.evidence.length, 0);
    assert.equal(revisedAssembly.staleEvidence.length, 2);
    assert.equal(revisedAssembly.latestReview, undefined);

    const partReview = reviewFailure({ ...loaded.state, phase: "final_review", phaseHistory: ["grill", "spec", "concept", "parts", "final_review"] });
    assert.deepEqual(legalWorkflowTransitions(partReview, loaded.workflow), [{ event: "revise_single_part", target: "parts" }]);
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
