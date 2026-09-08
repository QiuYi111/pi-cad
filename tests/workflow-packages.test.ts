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
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { resolveWorkflowPackage, workflowUserDirectory } from "../src/harness/workflow/packages.ts";

test("installed Mechanical packages expose only default and naked modes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-packages-"));
  try {
    const listed = await handleAgentApi(cwd, { schema: 1, op: "workflow-list" }) as any[];
    assert.deepEqual(listed.map((item) => item.id), ["mechanical.default", "mechanical.naked"]);
    for (const item of listed) assert.deepEqual(Object.keys(item).sort(), ["description", "id", "tags", "version"]);
    const standard = await resolveWorkflowPackage(cwd, "mechanical.default", mechanicalRegistries);
    assert.equal(standard.workflow.initialPhase, "plan");
    assert.deepEqual(Object.keys(standard.workflow.phases), ["cook", "done", "final", "plan"]);
    assert.deepEqual(standard.workflow.phases.plan!.recordObligations.map((item) => item.ref), ["plan"]);
    assert.equal(standard.workflow.phases.plan!.evidenceObligations[0]?.ref, "concept-image");
    assert.equal(standard.workflow.phases.plan!.evidenceObligations[0]?.required, false);
    assert.deepEqual(standard.workflow.phases.cook!.recordObligations, []);
    assert.deepEqual(standard.workflow.phases.cook!.evidenceObligations, []);
    assert.match(standard.workflow.phases.cook!.guidance, /CAD cannot be\s+fake/);
    assert.deepEqual(Object.keys(standard.workflow.phases.final!.transitions), ["accepted", "replan", "revise"]);
    assert.equal(standard.workflow.phases.done!.terminal, true);
    const naked = await resolveWorkflowPackage(cwd, "mechanical.naked", mechanicalRegistries);
    assert.equal(naked.workflow.initialPhase, "work");
    assert.equal(naked.workflow.phases.work!.guidance, undefined);
    assert.deepEqual(naked.workflow.phases.work!.recordObligations, []);
    assert.deepEqual(naked.workflow.phases.work!.evidenceObligations, []);
    assert.equal(naked.workflow.phases.work!.actions.includes("cad_build_step"), true);
    assert.equal(naked.workflow.phases.work!.actions.includes("cad_simulate"), true);
    const started = await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.default" }) as any;
    assert.equal(started.phase, "plan");
    assert.deepEqual(started.unmet, ["plan"]);
    await assert.rejects(handleAgentApi(cwd, { schema: 1, op: "model-build", source: "part.py", output: "build/part.step" }), /model\.build is not granted in workflow phase plan/);
    await handleAgentApi(cwd, { schema: 1, op: "commit", name: "plan" });
    const advanced = await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "plan_ready" }) as any;
    assert.equal(advanced.phase, "cook");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("user-authored package YAML is compiler-admitted and source edits cannot alter a pinned run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-authoring-"));
  const directory = workflowUserDirectory();
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
    await mkdir(directory, { recursive: true });
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

test("administrator adoption selects an exact workflow version while existing runs retain their snapshot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-adoption-"));
  const upgradedCwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-adoption-next-"));
  const packageSource = (version: string, purpose: string) => `schema: 1\nid: custom.versioned\ndescription: Versioned workflow.\ntags: [custom]\nversion: ${version}\nworkflow:\n  schema: 1\n  id: custom.versioned\n  version: ${version}\n  parametersSchema: {type: object, additionalProperties: false}\n  initialPhase: work\n  phases:\n    work:\n      purpose: ${purpose}\n      actions: []\n      grants: [file_read]\n      writeScopes: []\n      recordObligations: []\n      evidenceObligations: []\n      contextProviders: [kernel.current-action]\n      hooks: []\n      transitions: {}\n      terminal: true\n`;
  try {
    const directory = workflowUserDirectory();
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "v1.yaml"), packageSource("1.0.0", "Version one.")); await writeFile(join(directory, "v2.yaml"), packageSource("2.0.0", "Version two."));
    await assert.rejects(resolveWorkflowPackage(cwd, "custom.versioned", mechanicalRegistries), /administrator adoption is required/);
    const policyPath = join(directory, "..", "workflow-adoptions.json");
    const policy = (version: string) => ({ schema: 1, globalSafetyPolicyVersion: "safety-1", adopted: { "custom.versioned": { version, adoptedBy: "admin", adoptedAt: "2026-03-10T00:00:00.000Z" } }, history: [{ id: "custom.versioned", to: version, adoptedBy: "admin", adoptedAt: "2026-03-10T00:00:00.000Z" }] });
    await writeFile(policyPath, JSON.stringify(policy("1.0.0")));
    const first = await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "custom.versioned" }) as any; const firstRun = first.runId;
    assert.equal(first.workflowVersion, "1.0.0");
    await writeFile(policyPath, JSON.stringify(policy("2.0.0")));
    const second = await handleAgentApi(upgradedCwd, { schema: 1, op: "workflow-start", id: "custom.versioned" }) as any;
    assert.equal(second.workflowVersion, "2.0.0");
    const restored = await new HarnessRunStoreV7(cwd, firstRun).load(mechanicalRegistries);
    assert.equal(restored?.workflow.version, "1.0.0"); assert.equal(restored?.workflow.phases.work?.purpose, "Version one.");
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(upgradedCwd, { recursive: true, force: true }); }
});
