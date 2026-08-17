import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptCandidate,
  commitPlan,
  commitRequirements,
  finish,
  route,
  transition,
  waitForUser,
  resumeFromUser,
} from "../src/core/state-machine.ts";
import type { CadProjectState, CadRequirements } from "../src/shared/protocol.ts";

const req: CadRequirements = {
  goal: "full workflow test",
  deliverables: ["STEP", "source"],
  must: [],
  preferences: [],
  assumptions: [],
  openUnknowns: [],
  maturity: "prototype",
};

function routeTo(wf: Parameters<typeof route>[1]) {
  const r = route(null, wf, "test");
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  return commitRequirements(r.state, req);
}

function candidate(state: CadProjectState) {
  const r = acceptCandidate(
    state,
    {
      label: "candidate-v1",
      sources: ["models/test.py"],
      sourceHashes: { "models/test.py": "source-hash" },
      sourcePath: "models/test.py",
      artifactPath: "build/test.step",
    },
    "artifact-hash",
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  return r.state;
}

function withEvidence(state: CadProjectState, kinds: Array<"visual" | "geometry" | "compare">, hash = "artifact-hash") {
  return {
    ...state,
    evidence: kinds.map((kind) => ({
      id: `${kind}-1`,
      kind,
      tool: `cad_${kind}`,
      artifactHash: hash,
      paths: [`evidence/${kind}.png`],
      createdAt: new Date().toISOString(),
    })),
  };
}

test("analyze path: baseline -> investigate -> explain -> ready -> done", () => {
  const c = routeTo("analyze");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadProjectState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  let t = transition(state, "baseline_understood", "understood");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "investigate");
  t = transition(t.state, "more_probe", "one more probe");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "cause_understood", "cause found");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "explain");
  t = transition(t.state, "findings_delivered", "delivered");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "ready");
  const f = finish(t.state);
  assert.equal(f.ok, true); if (!f.ok) return;
  assert.equal(f.state.phase, "done");
});

test("modify path: plan -> modify -> review -> accepted requires compare evidence", () => {
  const c = routeTo("modify");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadProjectState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  let t = transition(state, "baseline_understood", "understood");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "plan");
  const p = commitPlan(t.state, { summary: "plan", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] });
  assert.equal(p.ok, true); if (!p.ok) return;
  assert.equal(p.state.phase, "modify");
  state = candidate(p.state);
  assert.equal(state.phase, "review");
  const blocked = transition(state, "accepted", "no compare yet");
  assert.equal(blocked.ok, false);
  state = withEvidence(state, ["visual", "geometry", "compare"]);
  t = transition(state, "accepted", "reviewed diff");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "ready");
});

test("greenfield path: concept -> intent -> build -> review -> accepted", () => {
  const c = routeTo("greenfield");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = c.state;
  assert.equal(state.phase, "concept");
  let t = transition(state, "domain_work_needed", "need optics analysis");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "domain_question_answered", "answered");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "direction_selected", "architecture selected");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "intent");
  const p = commitPlan(t.state, { summary: "intent", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] });
  assert.equal(p.ok, true); if (!p.ok) return;
  assert.equal(p.state.phase, "build");
  state = candidate(p.state);
  state = withEvidence(state, ["visual", "geometry"]);
  t = transition(state, "accepted", "reviewed");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "ready");
});

test("convert path: source_baseline -> transform_plan -> convert -> compare -> accepted", () => {
  const c = routeTo("convert");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadProjectState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  assert.equal(state.phase, "source_baseline");
  let t = transition(state, "baseline_understood", "understood");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "transform_plan");
  const p = commitPlan(t.state, { summary: "transform", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] });
  assert.equal(p.ok, true); if (!p.ok) return;
  assert.equal(p.state.phase, "convert");
  state = candidate(p.state);
  assert.equal(state.phase, "compare");
  state = withEvidence(state, ["visual", "geometry", "compare"]);
  t = transition(state, "accepted", "matched");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "ready");
});

test("release path requires all workstream statuses before finish", () => {
  const c = routeTo("release");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = c.state;
  assert.equal(state.phase, "audit");
  const ws = [
    "design_definition",
    "manufacturing_definition",
    "bom",
    "assembly_service",
    "inspection_acceptance",
    "engineering_analysis",
    "risk_quality",
    "configuration",
    "presentation",
  ].map((name) => ({ name, status: "complete" as const }));
  const p = commitPlan(state, { summary: "release audit", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [], workstreams: ws });
  assert.equal(p.ok, true); if (!p.ok) return;
  state = p.state;
  let t = transition(state, "audit_complete", "gaps closed");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "workstreams_structurally_closed", "closed");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "package");
  t = transition(t.state, "package_prepared", "package ready");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "final_review");
  t = transition(t.state, "accepted", "release accepted");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "ready");
  const readyWithArtifact: CadProjectState = {
    ...t.state,
    currentSourcePath: "models/release.py",
    currentSourceHash: "source-hash",
    currentArtifactPath: "build/release.step",
    currentArtifactHash: "artifact-hash",
  };
  const f = finish(withEvidence(readyWithArtifact, ["visual", "geometry"]));
  assert.equal(f.ok, true); if (!f.ok) return;
  assert.equal(f.state.phase, "done");
});

test("wait_for_user pauses and resumeFromUser restores same phase", () => {
  const c = routeTo("quick");
  assert.equal(c.ok, true); if (!c.ok) return;
  const w = waitForUser(c.state, "need material");
  assert.equal(w.ok, true); if (!w.ok) return;
  assert.equal(w.state.status, "waiting_user");
  const resumed = resumeFromUser(w.state);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.phase, "build");
});
