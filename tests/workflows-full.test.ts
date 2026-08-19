import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptCandidate,
  commitPhaseRecord,
  commitPlan,
  commitRequirements,
  finish,
  route,
  transition,
  waitForUser,
  resumeFromUser,
} from "../src/core/state-machine.ts";
import type { CadRunState, CadRequirements, Route } from "../src/shared/protocol.ts";

const req: CadRequirements = {
  goal: "full workflow test",
  deliverables: ["STEP", "source"],
  must: [],
  preferences: [],
  assumptions: [],
  openUnknowns: [],
};

const minimalPlan = { summary: "plan", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] };

const ROUTES = {
  analyze: { objective: "analyze" },
  convert: { objective: "convert" },
  // 0.7 modify == 0.8 legacy part
  modify: { objective: "design", lineage: "legacy", structure: "part", maturity: "engineering" },
  // 0.7 greenfield == 0.8 hybrid part (greenfield part is the fast path now)
  greenfield: { objective: "design", lineage: "hybrid", structure: "part", maturity: "prototype" },
  // 0.7 release == 0.8 greenfield part release
  release: { objective: "design", lineage: "greenfield", structure: "part", maturity: "release" },
  // 0.7 quick == 0.8 greenfield part prototype (fast path)
  quick: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" },
} as const satisfies Record<string, Route>;

function routeTo(wf: keyof typeof ROUTES) {
  const r = route(null, ROUTES[wf] as Route, "test");
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  return commitRequirements(r.state, req);
}

function candidate(state: CadRunState) {
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

function withEvidence(state: CadRunState, kinds: Array<"visual" | "geometry" | "compare">, hash = "artifact-hash") {
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
  let state: CadRunState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
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
  let state: CadRunState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
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

test("hybrid part path: baseline -> concept -> part_design -> build -> review -> accepted", () => {
  const c = routeTo("greenfield");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadRunState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  let t = transition(state, "baseline_understood", "understood");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "concept");
  t = transition(t.state, "domain_work_needed", "need optics analysis");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "domain_question_answered", "answered");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "direction_selected", "architecture selected");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "part_design");
  const p = commitPlan(t.state, minimalPlan);
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
  let state: CadRunState = { ...c.state, baselineArtifactPath: "old.step", baselineArtifactHash: "baseline-hash" };
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
  assert.equal(t.state.phase, "gap_closure");
  state = candidate(t.state);
  assert.equal(state.phase, "audit");
  state = withEvidence(state, ["visual", "geometry"]);
  t = transition(state, "workstreams_structurally_closed", "closed");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "package");
  t = transition(t.state, "package_prepared", "package ready");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "final_review");
  t = transition(t.state, "accepted", "release accepted");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "ready");
  const readyWithArtifact: CadRunState = {
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
  assert.equal(resumed.phase, "part_design");
});

test("required simulation evidence obligation blocks acceptance and finish until current simulation exists", () => {
  const c = routeTo("quick");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = { ...c.state, evidenceObligations: { simulation: { disposition: "required" as const, rationale: "strength controls acceptance" } } };
  const planned = commitPlan(state, minimalPlan);
  assert.equal(planned.ok, true); if (!planned.ok) return;
  state = candidate(planned.state);
  state = withEvidence(state, ["visual", "geometry"]);
  const blocked = transition(state, "accepted", "no simulation");
  assert.equal(blocked.ok, false);

  state = {
    ...state,
    evidence: [
      ...state.evidence,
      {
        id: "sim-1",
        kind: "simulation" as const,
        tool: "cad_simulate",
        artifactHash: "artifact-hash",
        paths: ["evidence/simulation-result.json"],
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const accepted = transition(state, "accepted", "simulation current");
  assert.equal(accepted.ok, true);
});

test("simulation tool availability follows the 0.6 matrix", async () => {
  const { toolsForPhase } = await import("../src/core/policies.ts");
  const phase = (p: string) => toolsForPhase(p as any);
  assert.ok(phase("review").includes("cad_simulate"));
  assert.ok(phase("review").includes("cad_optimize"));
  assert.ok(phase("investigate").includes("cad_simulate"));
  assert.ok(!phase("investigate").includes("cad_optimize"));
  assert.ok(phase("audit").includes("cad_simulate"));
  assert.ok(!phase("audit").includes("cad_optimize"));
  assert.ok(phase("gap_closure").includes("cad_simulate"));
  assert.ok(phase("gap_closure").includes("cad_optimize"));
  assert.ok(phase("final_review").includes("cad_simulate"));
  assert.ok(!phase("final_review").includes("cad_optimize"));
  assert.ok(!phase("build").includes("cad_simulate"));
});

test("analyze required simulation evidence is bound to the baseline artifact", () => {
  const c = routeTo("analyze");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadRunState = {
    ...c.state,
    evidenceObligations: {
      simulation: { disposition: "required", rationale: "quantitative load path determines diagnosis" },
    },
    baselineArtifactPath: "old.step",
    baselineArtifactHash: "baseline-hash",
  };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  let t = transition(state, "baseline_understood", "understood baseline");
  assert.equal(t.ok, true); if (!t.ok) return;
  t = transition(t.state, "cause_understood", "cause understood");
  assert.equal(t.ok, true); if (!t.ok) return;
  const blocked = transition(t.state, "findings_delivered", "cannot deliver without simulation");
  assert.equal(blocked.ok, false);
  const blockedFinishState: CadRunState = { ...t.state, phase: "ready", status: "ready" };
  const blockedFinish = finish(blockedFinishState);
  assert.equal(blockedFinish.ok, false);

  const withSimulation: CadRunState = {
    ...t.state,
    evidence: [
      ...t.state.evidence,
      {
        id: "simulation-baseline",
        kind: "simulation" as const,
        tool: "cad_simulate",
        artifactHash: "baseline-hash",
        paths: ["evidence/simulation-result.json"],
        artifacts: [{ path: "evidence/simulation-result.json", sha256: "simulation-hash" }],
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const delivered = transition(withSimulation, "findings_delivered", "simulation current");
  assert.equal(delivered.ok, true);
});

test("assembly route: build is blocked until assembly_design and interface_contracts records exist", () => {
  const r = route(
    null,
    { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "engineering" },
    "assembly test",
  );
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = c.state;
  assert.equal(state.phase, "system_concept");
  let t = transition(state, "direction_selected", "topology chosen");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "assembly_design");

  // Committing a plan from assembly_design is not valid: the record is the exit.
  const prematurePlan = commitPlan(t.state, minimalPlan);
  assert.equal(prematurePlan.ok, false);

  const design = commitPhaseRecord(t.state, "assembly_design", {
    summary: "two-module bracket",
    modules: [
      { name: "base", purpose: "mounts to rail" },
      { name: "arm", purpose: "carries the load" },
    ],
    datums: [{ name: "A", kind: "primary", definedBy: "base bottom face" }],
    sequence: [{ step: 1, installs: ["base"] }],
  });
  assert.equal(design.ok, true); if (!design.ok) return;
  assert.equal(design.state.phase, "interface_design");
  assert.deepEqual(design.state.phaseRecords, ["assembly_design"]);

  // plan commit still not valid in interface_design; contracts are the exit.
  const prematurePlan2 = commitPlan(design.state, minimalPlan);
  assert.equal(prematurePlan2.ok, false);

  const contracts = commitPhaseRecord(design.state, "interface_contracts", {
    contracts: [
      {
        id: "base-arm",
        a: "base",
        b: "arm",
        purpose: "locate arm on base",
        locating: "pin in hole against datum A",
        dof: "all six constrained",
        fasteners: "2 x M5 SHCS",
        fits: "H7/g6 pin",
        assemblyDirection: "+Z",
        toolAccess: "top-down driver",
      },
    ],
  });
  assert.equal(contracts.ok, true); if (!contracts.ok) return;
  assert.equal(contracts.state.phase, "part_design");
  assert.deepEqual(contracts.state.phaseRecords, ["assembly_design", "interface_contracts"]);

  // Now the plan may enter build.
  const p = commitPlan(contracts.state, minimalPlan);
  assert.equal(p.ok, true); if (!p.ok) return;
  assert.equal(p.state.phase, "build");

  // Candidate requires current-version records too (re-check after reroute etc.)
  state = candidate(p.state);
  assert.equal(state.phase, "integration_review");

  // Integration review requires assembly evidence alongside visual/geometry.
  const blocked = transition(state, "accepted", "no assembly evidence");
  assert.equal(blocked.ok, false);
  const withAll = withEvidence(state, ["visual", "geometry", "assembly"] as never);
  const accepted = transition(withAll, "accepted", "integration verified");
  assert.equal(accepted.ok, true); if (!accepted.ok) return;
  assert.equal(accepted.state.phase, "ready");
});

test("assembly route: records cannot be bypassed via cad_transition events", () => {
  const r = route(
    null,
    { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "prototype" },
    "assembly bypass attempt",
  );
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = c.state;
  const t = transition(state, "direction_selected", "chosen");
  assert.equal(t.ok, true); if (!t.ok) return;
  // Firing the record event without the record fails closed.
  const bypass = transition(t.state, "assembly_design_committed", "cheating");
  assert.equal(bypass.ok, false);
  // And prototype assemblies still owe both records (a prototype is not a
  // concept: obligations never disappear).
  const design = commitPhaseRecord(t.state, "assembly_design", {
    summary: "x", modules: [{ name: "a", purpose: "x" }, { name: "b", purpose: "y" }],
    datums: [{ name: "A", kind: "primary", definedBy: "f" }],
    sequence: [{ step: 1, installs: ["a"] }],
  });
  assert.equal(design.ok, true); if (!design.ok) return;
  const contracts = commitPhaseRecord(design.state, "interface_contracts", {
    contracts: [{ id: "i", a: "a", b: "b", purpose: "x", locating: "x", dof: "x", fasteners: "x", fits: "x", assemblyDirection: "+Z", toolAccess: "x" }],
  });
  assert.equal(contracts.ok, true); if (!contracts.ok) return;
  const p = commitPlan(contracts.state, minimalPlan);
  assert.equal(p.ok, true);
});

test("part route owes no records: plan enters build directly", () => {
  const r = route(
    null,
    { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" },
    "part test",
  );
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  // Part routes have no phase records — no obligation exists to satisfy.
  const p = commitPlan(c.state, minimalPlan);
  assert.equal(p.ok, true); if (!p.ok) return;
  assert.equal(p.state.phase, "build");
  const badRecord = commitPhaseRecord(c.state, "assembly_design", {});
  assert.equal(badRecord.ok, false);
});
