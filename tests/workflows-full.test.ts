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

const frameContext = {
  disposition: "confirmed" as const,
  axes: [
    { axis: "x", mapsTo: "machine X (rail direction)" },
    { axis: "y", mapsTo: "machine Y" },
    { axis: "z", mapsTo: "machine up" },
  ],
  howConfirmed: "user confirmed the bolt-pattern face is the mounting plane",
};

function commitFrameContext(state: CadRunState) {
  const r = commitPhaseRecord(state, "frame_context", frameContext);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}
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

function withEvidence(
  state: CadRunState,
  kinds: Array<"visual" | "geometry" | "compare" | "assembly" | "drawing" | "interference" | "presentation">,
  hash = "artifact-hash",
) {
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
  state = commitFrameContext(state);
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
  state = commitFrameContext(state);
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
  state = commitFrameContext(state);
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
  state = commitFrameContext(state);
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

test("release path: design core runs first, then the release suffix closes", () => {
  const c = routeTo("release");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = c.state;
  // Greenfield part + release: the DESIGN CORE (fast path) runs first —
  // release never replaces the design process.
  assert.equal(state.phase, "part_design");
  const planned = commitPlan(state, minimalPlan);
  assert.equal(planned.ok, true); if (!planned.ok) return;
  assert.equal(planned.state.phase, "build");
  state = candidate(planned.state);
  assert.equal(state.phase, "review");
  // The design review accepted needs the core evidence only — drawing and
  // presentation gate the CLOSURE (final_review), not the hand-off.
  state = withEvidence(state, ["visual", "geometry"]);
  let t = transition(state, "accepted", "design accepted");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "audit");
  assert.equal(t.state.status, "active");
  state = t.state;
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
  t = transition(state, "audit_complete", "gaps closed");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "gap_closure");
  state = candidate(t.state);
  assert.equal(state.phase, "audit");
  // Maturity overlay: release owes drawing + presentation evidence on top
  // of visual/geometry.
  state = withEvidence(state, ["visual", "geometry", "drawing", "presentation"] as never);
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
  const f = finish(withEvidence(readyWithArtifact, ["visual", "geometry", "drawing", "presentation"]));
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
  state = commitFrameContext(state);
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

  // Integration review requires assembly + interference evidence alongside visual/geometry.
  const blocked = transition(state, "accepted", "no assembly evidence");
  assert.equal(blocked.ok, false);
  const withAll = withEvidence(state, ["visual", "geometry", "assembly", "interference"] as never);
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

test("release closure requires presentation deliverables in current evidence", async () => {
  const { verifyPresentationDeliverables } = await import("../src/core/evidence.ts");
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-rel-pres-"));
  try {
    const base = routeTo("release");
    assert.equal(base.ok, true); if (!base.ok) return;
    const hash = "h".repeat(64);
    const atReady: CadRunState = {
      ...base.state,
      phase: "ready",
      status: "ready",
      currentSourcePath: "models/x.py",
      currentSourceHash: "s".repeat(64),
      currentArtifactPath: "build/x.step",
      currentArtifactHash: hash,
    };
    // Presentation evidence with NO manifest deliverables -> blocked.
    const noManifest = withEvidence(atReady, ["visual", "geometry", "drawing", "presentation"]);
    const blocked = await verifyPresentationDeliverables(cwd, noManifest);
    assert.ok(blocked);
    assert.match(blocked, /deliverables missing/);

    // With a rendered manifest declaring the deliverables -> pass.
    const evidenceDir = join(cwd, "evidence", "presentation");
    mkdirSync(evidenceDir, { recursive: true });
    for (const name of ["exploded.png", "hero.png"]) {
      writeFileSync(join(evidenceDir, name), "png bytes");
    }
    const manifest = {
      status: "rendered",
      outputs: {
        "hero.png": { path: join(evidenceDir, "hero.png"), sha256: "h" },
        "exploded.png": { path: join(evidenceDir, "exploded.png"), sha256: "x" },
        "turntable.mp4": { path: join(evidenceDir, "turntable.mp4"), sha256: "y" },
        "assembly.mp4": { path: join(evidenceDir, "assembly.mp4"), sha256: "z" },
      },
    };
    writeFileSync(join(evidenceDir, "manifest.json"), JSON.stringify(manifest));
    const withManifest: CadRunState = {
      ...atReady,
      evidence: [
        ...noManifest.evidence,
        {
          id: "pres-2",
          kind: "presentation" as const,
          tool: "cad_render_scene",
          artifactHash: hash,
          paths: [join(evidenceDir, "manifest.json")],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const ok = await verifyPresentationDeliverables(cwd, withManifest);
    assert.equal(ok, null);

    // Part release does not demand the assembly animation.
    const partRelease = route(null, { objective: "design", lineage: "greenfield", structure: "part", maturity: "release" }, "t");
    assert.equal(partRelease.ok, true); if (!partRelease.ok) return;
    const partState = { ...withManifest, route: partRelease.state.route };
    const partCheck = await verifyPresentationDeliverables(cwd, { ...partState });
    assert.equal(partCheck, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("frame context gates baseline_understood for every baseline-bound route", () => {
  const r = route(null, { objective: "design", lineage: "legacy", structure: "part", maturity: "engineering" }, "t");
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadRunState = {
    ...c.state,
    baselineArtifactPath: "old.step",
    baselineArtifactHash: "baseline-hash",
  };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  // Without the frame context record, leaving baseline is blocked.
  const blocked = transition(state, "baseline_understood", "skipped the frame question");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /frame_context/);
  state = commitFrameContext(state);
  const t = transition(state, "baseline_understood", "frame confirmed with user");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "plan");
  assert.deepEqual(t.state.phaseRecords, ["frame_context"]);
});

test("analyze routes also owe the frame context before leaving baseline", () => {
  const c = routeTo("analyze");
  assert.equal(c.ok, true); if (!c.ok) return;
  let state: CadRunState = {
    ...c.state,
    baselineArtifactPath: "old.step",
    baselineArtifactHash: "baseline-hash",
  };
  state = withEvidence(state, ["visual", "geometry"], "baseline-hash");
  const blocked = transition(state, "baseline_understood", "no frame context");
  assert.equal(blocked.ok, false);
  state = commitFrameContext(state);
  const t = transition(state, "baseline_understood", "confirmed");
  assert.equal(t.ok, true); if (!t.ok) return;
  assert.equal(t.state.phase, "investigate");
});

test("review regression stales downstream records and forces re-commit", () => {
  const r = route(
    null,
    { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "engineering" },
    "staleness",
  );
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  let state = c.state;
  let t = transition(state, "direction_selected", "chosen");
  assert.equal(t.ok, true); if (!t.ok) return;
  const design = commitPhaseRecord(t.state, "assembly_design", {
    summary: "v1", modules: [{ name: "a", purpose: "x" }, { name: "b", purpose: "y" }],
    datums: [{ name: "A", kind: "primary", definedBy: "f" }],
    sequence: [{ step: 1, installs: ["a"] }],
  });
  assert.equal(design.ok, true); if (!design.ok) return;
  const contracts = commitPhaseRecord(design.state, "interface_contracts", {
    contracts: [{ id: "i", a: "a", b: "b", purpose: "x", locating: "x", dof: "x", fasteners: "x", fits: "x", assemblyDirection: "+Z", toolAccess: "x" }],
  });
  assert.equal(contracts.ok, true); if (!contracts.ok) return;
  assert.deepEqual(contracts.state.phaseRecords, ["assembly_design", "interface_contracts"]);

  // Simulate being in integration_review (candidate path is exercised
  // elsewhere); the architecture regression sends the run back...
  const regression = transition({ ...contracts.state, phase: "integration_review" }, "architecture_issue", "decomposition wrong");
  assert.equal(regression.ok, true); if (!regression.ok) return;
  // ...and BOTH records are stale: the trail cannot be reused.
  assert.equal(regression.state.phase, "assembly_design");
  assert.deepEqual(regression.state.phaseRecords, []);
  const journal = regression.events.map((e) => e.type);
  assert.ok(journal.includes("PhaseRecordsStaled"));

  // Re-committing the assembly design is required to progress again; a
  // plan commit from assembly_design is still not valid.
  const premature = commitPlan(regression.state, minimalPlan);
  assert.equal(premature.ok, false);
  const redesign = commitPhaseRecord(regression.state, "assembly_design", {
    summary: "v2", modules: [{ name: "a2", purpose: "x" }, { name: "b2", purpose: "y" }],
    datums: [{ name: "A", kind: "primary", definedBy: "f" }],
    sequence: [{ step: 1, installs: ["a2"] }],
  });
  assert.equal(redesign.ok, true); if (!redesign.ok) return;
  assert.deepEqual(redesign.state.phaseRecords, ["assembly_design"]);
  assert.equal(redesign.state.phase, "interface_design");

  // interface_contracts was staled too: entering interface_design fresh
  // means the contracts must be committed again before part_design.
  const recontracts = commitPhaseRecord(redesign.state, "interface_contracts", {
    contracts: [{ id: "i2", a: "a2", b: "b2", purpose: "x", locating: "x", dof: "x", fasteners: "x", fits: "x", assemblyDirection: "+Z", toolAccess: "x" }],
  });
  assert.equal(recontracts.ok, true);
});

test("interface_or_detail_issue stales only the interface contracts", () => {
  const r = route(
    null,
    { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "engineering" },
    "staleness2",
  );
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  let t = transition(c.state, "direction_selected", "chosen");
  assert.equal(t.ok, true); if (!t.ok) return;
  const design = commitPhaseRecord(t.state, "assembly_design", {
    summary: "v1", modules: [{ name: "a", purpose: "x" }, { name: "b", purpose: "y" }],
    datums: [{ name: "A", kind: "primary", definedBy: "f" }],
    sequence: [{ step: 1, installs: ["a"] }],
  });
  const contracts = commitPhaseRecord(design.state, "interface_contracts", {
    contracts: [{ id: "i", a: "a", b: "b", purpose: "x", locating: "x", dof: "x", fasteners: "x", fits: "x", assemblyDirection: "+Z", toolAccess: "x" }],
  });
  assert.equal(contracts.ok, true); if (!contracts.ok) return;
  const regression = transition({ ...contracts.state, phase: "integration_review" }, "interface_or_detail_issue", "contract wrong");
  assert.equal(regression.ok, true); if (!regression.ok) return;
  assert.equal(regression.state.phase, "interface_design");
  // The assembly design record SURVIVES: only the contracts are stale.
  assert.deepEqual(regression.state.phaseRecords, ["assembly_design"]);
});

test("frame context dispositions: harness forces handling, not necessarily asking", () => {
  const r = route(null, { objective: "design", lineage: "legacy", structure: "part", maturity: "engineering" }, "t");
  assert.equal(r.ok, true); if (!r.ok) return;
  const c = commitRequirements(r.state, req);
  assert.equal(c.ok, true); if (!c.ok) return;
  const state: CadRunState = {
    ...c.state,
    baselineArtifactPath: "old.step",
    baselineArtifactHash: "baseline-hash",
  };
  // not_applicable (pure convert-style carry-through) still satisfies the gate.
  const na = commitPhaseRecord(state, "frame_context", {
    disposition: "not_applicable",
    axes: [
      { axis: "x", mapsTo: "file +X carried through verbatim" },
      { axis: "y", mapsTo: "file +Y carried through verbatim" },
      { axis: "z", mapsTo: "file +Z carried through verbatim" },
    ],
    howConfirmed: "coordinates pass through unchanged and no direction is referenced in the task",
  });
  assert.equal(na.ok, true);
  // user_declined also satisfies the gate — the question was handled.
  const declined = commitPhaseRecord(state, "frame_context", {
    disposition: "user_declined",
    axes: [
      { axis: "x", mapsTo: "file +X (best-effort reading)" },
      { axis: "y", mapsTo: "file +Y (best-effort reading)" },
      { axis: "z", mapsTo: "file +Z (best-effort reading)" },
    ],
    howConfirmed: "asked via cad_wait_for_user; user declined to specify a machine frame",
  });
  assert.equal(declined.ok, true);
  // Still no silent skip: without the record, baseline_understood stays blocked.
  const blocked = transition(state, "baseline_understood", "no record");
  assert.equal(blocked.ok, false);
});

test("release design-review accepted enters audit without closure deliverables or moving the head", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync: wfs } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const pi: any = {
    tools: new Map(),
    handlers: new Map(),
    activeTools: [],
    events: { emit() {}, on() {} },
    registerTool(tool: any) {
      pi.tools.set(tool.name, tool);
    },
    on(event: string, handler: any) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    registerCommand() {},
    setActiveTools() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    appendEntry() {},
    sendUserMessage() {},
  };
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);

  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-release-closure-"));
  try {
    const ctx = { cwd };
    const routeTool = pi.tools.get("cad_route");
    const reqTool = pi.tools.get("cad_commit_requirements");
    const planTool = pi.tools.get("cad_commit_plan");
    const designTool = pi.tools.get("cad_commit_assembly_design");
    const contractsTool = pi.tools.get("cad_commit_interface_contracts");
    const candidateTool = pi.tools.get("cad_commit_candidate");
    const transitionTool = pi.tools.get("cad_transition");

    await routeTool.execute(
      "c1",
      { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "release", reason: "release assembly" },
      undefined, undefined, ctx,
    );
    await reqTool.execute(
      "c2",
      { goal: "g", deliverables: ["STEP"], must: [], preferences: [], assumptions: [], openUnknowns: [] },
      undefined, undefined, ctx,
    );
    await transitionTool.execute("c3", { event: "direction_selected", note: "two boxes" }, undefined, undefined, ctx);
    await designTool.execute(
      "c4",
      { summary: "s", modules: [{ name: "a", purpose: "x" }, { name: "b", purpose: "y" }], datums: [{ name: "A", kind: "primary", definedBy: "f" }], sequence: [{ step: 1, installs: ["a"] }] },
      undefined, undefined, ctx,
    );
    await contractsTool.execute(
      "c5",
      { contracts: [{ id: "i", a: "a", b: "b", purpose: "x", locating: "x", dof: "x", fasteners: "x", fits: "x", assemblyDirection: "+Z", toolAccess: "x" }] },
      undefined, undefined, ctx,
    );
    await planTool.execute("c6", { summary: "p", protected: [], plannedChanges: [], interfaces: [], datums: [], reviewPlan: [] }, undefined, undefined, ctx);

    mkdirSync(join(cwd, "models"), { recursive: true });
    wfs(
      join(cwd, "models", "assembly.py"),
      [
        "import build123d as bd",
        "with bd.BuildPart() as p:",
        "    bd.Box(30, 30, 10)",
        "    a = p.part",
        "with bd.BuildPart() as p:",
        "    bd.Box(12, 12, 25)",
        "    b = p.part",
        "result = bd.Compound([a, b.moved(bd.Location((0, 0, 17.5)))])",
        "",
      ].join("\n"),
    );
    const committed = await candidateTool.execute("c7", { sources: ["models/assembly.py"], label: "r1" }, undefined, undefined, ctx);
    assert.match(committed.content[0].text as string, /INTEGRATION_REVIEW/);

    // The design review accepted: only the design-core evidence is present
    // (visual, geometry, assembly, interference) — no drawing, no
    // presentation, no workstream statuses. The old controller would have
    // blocked here demanding release deliverables; now it enters audit.
    const accepted = await transitionTool.execute("c8", { event: "accepted", note: "design core accepted" }, undefined, undefined, ctx);
    assert.match(accepted.content[0].text as string, /AUDIT/);

    // The project head did NOT move: head commits only at closure (ready).
    const project = JSON.parse(readFileSync(join(cwd, ".pi-cad", "project.json"), "utf-8"));
    assert.ok(!project.head.artifactPath, "design-review accepted must not update the project head");

    // ...and the closure still demands the deliverables: final_review
    // accepted is blocked without presentation evidence with a manifest.
    const state = JSON.parse(
      readFileSync(join(cwd, ".pi-cad", "runs", project.currentRunId, "state.json"), "utf-8"),
    );
    const atFinal: typeof state = { ...state, phase: "final_review", status: "active" };
    // Simulate being in final_review via the pure machine + controller gate:
    const { verifyPresentationDeliverables } = await import("../src/core/evidence.ts");
    const check = await verifyPresentationDeliverables(cwd, atFinal);
    assert.ok(check);
    assert.match(check, /hero\.png|turntable\.mp4/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
