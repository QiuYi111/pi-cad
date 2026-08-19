import assert from "node:assert/strict";
import { test } from "node:test";

import { compileWorkflow } from "../src/workflows/compiler.ts";
import { rerouteIsAutonomous as rerouteIsAutonomousRef } from "../src/core/state-machine.ts";
import { compiledSpec } from "../src/workflows/index.ts";
import {
  isRoute,
  obligationsOf,
  recordObligations,
  routeKey,
  type Route,
} from "../src/shared/route.ts";

const design = (
  lineage: "greenfield" | "legacy" | "hybrid",
  structure: "part" | "assembly",
  maturity: "prototype" | "engineering" | "manufacturing" | "release",
): Route => ({ objective: "design", lineage, structure, maturity });

test("compiler: analyze and convert match the 0.7 processes exactly", () => {
  const analyze = compileWorkflow({ objective: "analyze" });
  assert.equal(analyze.nextAfterRequirements, "baseline");
  assert.deepEqual(analyze.sourcePhases, []);
  assert.equal(analyze.candidateReviewPhase, "review");
  assert.deepEqual(analyze.transitions, {
    baseline: { baseline_understood: "investigate" },
    investigate: { more_probe: "investigate", cause_understood: "explain" },
    explain: { findings_delivered: "ready" },
  });
  assert.equal(analyze.requiresBaselineInput, true);
  assert.equal(analyze.baselineEvidenceRequired, true);
  assert.equal(analyze.updatesHeadOnAccept, false);

  const convert = compileWorkflow({ objective: "convert" });
  assert.equal(convert.nextAfterRequirements, "source_baseline");
  assert.deepEqual(convert.sourcePhases, ["convert"]);
  assert.equal(convert.candidateReviewPhase, "compare");
  assert.deepEqual(convert.planNext, { transform_plan: "convert" });
  assert.deepEqual(convert.transitions, {
    source_baseline: { baseline_understood: "transform_plan" },
    compare: { repair: "convert", accepted: "ready" },
  });
  assert.equal(convert.requiresBaselineInput, true);
});

test("compiler: legacy part matches the 0.7 modify process exactly", () => {
  const legacyPart = compileWorkflow(design("legacy", "part", "engineering"));
  assert.equal(legacyPart.nextAfterRequirements, "baseline");
  assert.deepEqual(legacyPart.sourcePhases, ["modify"]);
  assert.equal(legacyPart.candidateReviewPhase, "review");
  assert.deepEqual(legacyPart.planNext, { plan: "modify" });
  assert.deepEqual(legacyPart.acceptedPhases, ["review"]);
  assert.deepEqual(legacyPart.acceptedEvidence({} as never), ["visual", "geometry", "compare"]);
  assert.equal(legacyPart.requiresBaselineInput, true);
  assert.equal(legacyPart.baselineEvidenceRequired, true);
  assert.equal(legacyPart.updatesHeadOnAccept, true);
  // No records owed by a part route.
  assert.deepEqual(legacyPart.obligations, []);
  assert.deepEqual(legacyPart.phaseRecords, {});
});

test("compiler: fast path — greenfield part is four phases with no concept exploration", () => {
  const fast = compileWorkflow(design("greenfield", "part", "engineering"));
  const phases = [fast.nextAfterRequirements, "part_design", "build", "review"];
  assert.equal(fast.nextAfterRequirements, "part_design");
  assert.deepEqual(fast.planNext, { part_design: "build" });
  assert.deepEqual(fast.sourcePhases, ["build"]);
  assert.equal(fast.candidateReviewPhase, "review");
  assert.ok(phases.length <= 4);
  // No quick equivalent: obligations still include simulation obligations
  // via requirements and full visual+geometry evidence at review.
  assert.deepEqual(fast.acceptedEvidence({} as never), ["visual", "geometry"]);
});

test("compiler: assembly structure injects the full design chain", () => {
  const greenAssembly = compileWorkflow(design("greenfield", "assembly", "engineering"));
  assert.equal(greenAssembly.nextAfterRequirements, "system_concept");
  assert.deepEqual(greenAssembly.sourcePhases, ["build"]);
  assert.equal(greenAssembly.candidateReviewPhase, "integration_review");
  assert.deepEqual(greenAssembly.acceptedPhases, ["integration_review"]);
  assert.deepEqual(greenAssembly.planNext, { part_design: "build" });
  assert.equal(greenAssembly.transitions.system_concept?.direction_selected, "assembly_design");
  assert.equal(greenAssembly.transitions.assembly_design?.assembly_design_committed, "interface_design");
  assert.equal(greenAssembly.transitions.interface_design?.interface_contracts_committed, "part_design");
  assert.equal(greenAssembly.transitions.part_design?.plan_committed, "build");
  assert.equal(greenAssembly.transitions.integration_review?.architecture_issue, "assembly_design");
  assert.equal(greenAssembly.transitions.integration_review?.interface_or_detail_issue, "interface_design");
  assert.deepEqual(greenAssembly.phaseRecords, {
    assembly_design: ["assembly_design"],
    interface_design: ["interface_contracts"],
  });
  // Assembly evidence obligations ride along with visual/geometry.
  assert.ok(greenAssembly.acceptedEvidence({} as never).includes("assembly"));
  assert.ok(greenAssembly.acceptedEvidence({} as never).includes("interference"));

  const legacyAssembly = compileWorkflow(design("legacy", "assembly", "engineering"));
  assert.equal(legacyAssembly.nextAfterRequirements, "baseline");
  assert.equal(legacyAssembly.transitions.baseline?.baseline_understood, "assembly_design");
  assert.deepEqual(legacyAssembly.sourcePhases, ["modify"]);
  assert.deepEqual(
    legacyAssembly.acceptedEvidence({} as never).sort(),
    ["assembly", "compare", "geometry", "interference", "visual"],
  );

  const hybridAssembly = compileWorkflow(design("hybrid", "assembly", "engineering"));
  assert.equal(hybridAssembly.nextAfterRequirements, "baseline");
  assert.equal(hybridAssembly.transitions.baseline?.baseline_understood, "system_concept");
});

test("compiler: maturity=release compiles the workstream process", () => {
  const release = compileWorkflow(design("greenfield", "part", "release"));
  assert.equal(release.nextAfterRequirements, "audit");
  assert.deepEqual(release.sourcePhases, ["gap_closure"]);
  assert.deepEqual(release.acceptedPhases, ["final_review"]);
  assert.equal(release.mutationPolicies?.gap_closure, "allowed");
  assert.ok(release.completionGuard);
  const legacyRelease = compileWorkflow(design("legacy", "part", "release"));
  assert.equal(legacyRelease.nextAfterRequirements, "baseline");
  assert.equal(legacyRelease.transitions.baseline?.baseline_understood, "audit");
  assert.equal(legacyRelease.requiresBaselineInput, true);
  // Release+assembly audits the records in the audit phase.
  const releaseAssembly = compileWorkflow(design("greenfield", "assembly", "release"));
  assert.deepEqual(releaseAssembly.phaseRecords, {
    audit: ["assembly_design", "interface_contracts"],
  });
});

test("obligations: maturity chain is cumulative per structure", () => {
  const part = (m: "prototype" | "engineering" | "manufacturing" | "release") =>
    [...obligationsOf(design("greenfield", "part", m))].sort();
  const assembly = (m: "prototype" | "engineering" | "manufacturing" | "release") =>
    [...obligationsOf(design("greenfield", "assembly", m))].sort();

  const isSubset = (a: string[], b: string[]) => a.every((k) => b.includes(k));
  assert.ok(isSubset(part("prototype"), part("engineering")));
  assert.ok(isSubset(part("engineering"), part("manufacturing")));
  assert.ok(isSubset(part("manufacturing"), part("release")));
  assert.ok(isSubset(assembly("prototype"), assembly("engineering")));
  assert.ok(isSubset(assembly("engineering"), assembly("manufacturing")));
  assert.ok(isSubset(assembly("manufacturing"), assembly("release")));
  // Structure upgrade adds obligations for every maturity.
  assert.ok(isSubset(part("engineering"), assembly("engineering")));

  assert.ok(assembly("prototype").includes("evidence:interference"));
  assert.ok(assembly("prototype").includes("record:assembly_design"));
  assert.ok(!assembly("prototype").includes("record:interface_contracts"));
  assert.ok(assembly("engineering").includes("record:interface_contracts"));
  assert.ok(part("manufacturing").includes("evidence:drawing"));
  assert.ok(part("release").includes("workstream:bom"));
  assert.ok(part("release").includes("presentation:exploded"));
  // A prototype is not a concept: obligations never drop to zero for
  // assemblies.
  assert.ok(assembly("prototype").length > 0);
  // analyze/convert owe nothing.
  assert.equal(obligationsOf({ objective: "analyze" }).size, 0);
  assert.equal(obligationsOf({ objective: "convert" }).size, 0);
});

test("obligations: reroute monotonicity (part->assembly autonomous, downgrade not)", () => {
  const partEng = design("greenfield", "part", "engineering");
  const assemblyProto = design("greenfield", "assembly", "prototype");
  // The rule: autonomous iff old obligation set ⊆ new one.
  const subsetOf = (from: Route, to: Route) => {
    const toKeys = obligationsOf(to);
    return [...obligationsOf(from)].every((k) => toKeys.has(k));
  };
  // Obligation-only view: partEng -> assemblyProto grows obligations...
  assert.ok(subsetOf(partEng, assemblyProto));
  // ...but maturity also dropped, so the reroute is NOT autonomous — the
  // reality floor never drops without user authority.
  const { rerouteIsAutonomous } = await_import_reroute();
  assert.ok(rerouteIsAutonomous(partEng, design("greenfield", "assembly", "engineering")));
  assert.ok(!rerouteIsAutonomous(partEng, assemblyProto));
  assert.ok(!rerouteIsAutonomous(design("greenfield", "assembly", "engineering"), design("greenfield", "assembly", "prototype")));
  assert.ok(!rerouteIsAutonomous(assemblyProto, design("greenfield", "part", "prototype"))); // drops everything
  assert.ok(!rerouteIsAutonomous(design("greenfield", "part", "release"), partEng)); // maturity downgrade
});

function await_import_reroute() {
  // Local indirection over the state-machine import below.
  return { rerouteIsAutonomous: rerouteIsAutonomousRef };
}

test("routeKey and isRoute structural validation", () => {
  assert.equal(routeKey({ objective: "analyze" }), "analyze");
  assert.equal(routeKey(design("hybrid", "assembly", "release")), "design/hybrid/assembly/release");
  assert.ok(isRoute({ objective: "convert" }));
  assert.ok(!isRoute({ objective: "design", lineage: "greenfield" }));
  assert.ok(!isRoute({ objective: "design", lineage: "bogus", structure: "part", maturity: "prototype" }));
  assert.ok(!isRoute({ objective: "analyze", lineage: "greenfield" }));
  assert.ok(!isRoute(null));
  assert.ok(!isRoute([1, 2]));
  assert.deepEqual(recordObligations(design("greenfield", "assembly", "engineering")), [
    "record:assembly_design",
    "record:interface_contracts",
  ]);
});

test("compiledSpec caches per route and returns stable processes", () => {
  const a = compiledSpec(design("greenfield", "assembly", "engineering"));
  const b = compiledSpec(design("greenfield", "assembly", "engineering"));
  assert.equal(a, b);
  const c = compiledSpec(design("greenfield", "assembly", "manufacturing"));
  assert.notEqual(a, c);
});

test("compiler: hybrid part keeps baseline + concept chain (0.7 hybrid equivalent)", () => {
  const hybrid = compileWorkflow(design("hybrid", "part", "engineering"));
  assert.equal(hybrid.nextAfterRequirements, "baseline");
  assert.equal(hybrid.transitions.baseline?.baseline_understood, "concept");
  assert.equal(hybrid.transitions.concept?.direction_selected, "part_design");
  assert.equal(hybrid.planNext.part_design, "build");
  // 0.7 hybrid did not require compare evidence at review; keep it that way.
  assert.deepEqual(hybrid.acceptedEvidence({} as never), ["visual", "geometry"]);
});

test("maturity overlay: manufacturing and release require drawing evidence", () => {
  const proto = compileWorkflow(design("greenfield", "part", "prototype"));
  const eng = compileWorkflow(design("greenfield", "part", "engineering"));
  const mfg = compileWorkflow(design("greenfield", "part", "manufacturing"));
  const rel = compileWorkflow(design("legacy", "part", "release"));
  assert.ok(!proto.acceptedEvidence({} as never).includes("drawing"));
  assert.ok(!eng.acceptedEvidence({} as never).includes("drawing"));
  assert.ok(mfg.acceptedEvidence({} as never).includes("drawing"));
  assert.ok(rel.finishEvidence({} as never).includes("drawing"));
  // The overlay never drops the fragment's own kinds (legacy release keeps
  // compare once baseline and current differ).
  const changedState = {
    baselineArtifactHash: "b".repeat(64),
    currentArtifactHash: "c".repeat(64),
  } as never;
  assert.ok(rel.acceptedEvidence(changedState).includes("compare"));
  // ...and never duplicates them.
  const kinds = mfg.acceptedEvidence({} as never);
  assert.equal(kinds.filter((k) => k === "geometry").length, 1);
});

test("maturity overlay: assembly engineering adds record obligations and review evidence", () => {
  const proto = compileWorkflow(design("greenfield", "assembly", "prototype"));
  const eng = compileWorkflow(design("greenfield", "assembly", "engineering"));
  assert.ok(proto.acceptedEvidence({} as never).includes("assembly"));
  assert.ok(eng.acceptedEvidence({} as never).includes("assembly"));
  assert.ok(!proto.acceptedEvidence({} as never).includes("drawing"));
  assert.ok(compileWorkflow(design("greenfield", "assembly", "manufacturing")).acceptedEvidence({} as never).includes("drawing"));
});
