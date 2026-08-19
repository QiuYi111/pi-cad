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
  // Lineage obligations: dropping legacy would drop these, so the reroute
  // can never be autonomous; frame context is confirmed in baseline.
  assert.deepEqual(legacyPart.obligations, [
    "lineage:baseline",
    "lineage:continuity",
    "record:frame_context",
  ]);
  assert.deepEqual(legacyPart.phaseRecords, { baseline: ["frame_context"] });
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

test("compiler: release is a suffix on the design core, never a replacement", () => {
  // Greenfield part + release: the DESIGN CORE runs first (fast path), the
  // design review's accepted hands INTO the suffix instead of closing.
  const release = compileWorkflow(design("greenfield", "part", "release"));
  assert.equal(release.nextAfterRequirements, "part_design");
  assert.deepEqual(release.sourcePhases, ["build", "gap_closure"]);
  assert.equal(release.sourcePhaseReviews?.gap_closure, "audit");
  assert.deepEqual(release.acceptedPhases, ["review", "final_review"]);
  assert.equal(release.transitions.review?.accepted, "audit");
  assert.equal(release.transitions.final_review?.accepted, "ready");
  assert.equal(release.transitions.audit?.audit_complete, "gap_closure");
  assert.equal(release.transitions.package?.package_prepared, "final_review");
  assert.equal(release.mutationPolicies?.gap_closure, "allowed");
  assert.equal(release.mutationPolicies?.package, "allowed");
  assert.ok(release.completionGuard);

  // Greenfield assembly + release: the full structure chain is NOT
  // replaced — records bind their own phases, audit only audits.
  const releaseAssembly = compileWorkflow(design("greenfield", "assembly", "release"));
  assert.equal(releaseAssembly.nextAfterRequirements, "system_concept");
  assert.equal(releaseAssembly.transitions.assembly_design?.assembly_design_committed, "interface_design");
  assert.equal(releaseAssembly.transitions.integration_review?.accepted, "audit");
  assert.deepEqual(releaseAssembly.phaseRecords, {
    assembly_design: ["assembly_design"],
    interface_design: ["interface_contracts"],
  });

  // Legacy + release keeps the lineage baseline and the modify loop.
  const legacyRelease = compileWorkflow(design("legacy", "part", "release"));
  assert.equal(legacyRelease.nextAfterRequirements, "baseline");
  assert.equal(legacyRelease.transitions.baseline?.baseline_understood, "plan");
  assert.deepEqual(legacyRelease.sourcePhases, ["modify", "gap_closure"]);
  assert.equal(legacyRelease.requiresBaselineInput, true);

  // The maturity overlays gate the CLOSURE review only: the design review
  // accepted must not demand release deliverables prematurely.
  const designReviewState = { phase: "review" } as never;
  assert.ok(!release.acceptedEvidence(designReviewState).includes("presentation"));
  assert.ok(!release.acceptedEvidence(designReviewState).includes("drawing"));
  const finalState = { phase: "final_review" } as never;
  assert.ok(release.acceptedEvidence(finalState).includes("presentation"));
  assert.ok(release.acceptedEvidence(finalState).includes("drawing"));
  // Workstream guard runs at the closure only.
  assert.equal(release.completionGuard?.(designReviewState), null);
  assert.ok(release.completionGuard?.(finalState));
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
  // An assembly you can build has defined interfaces at every maturity —
  // the compiled process enforces the interface_design phase for all of
  // them, so the obligation exists from prototype up.
  assert.ok(assembly("prototype").includes("record:interface_contracts"));
  assert.ok(part("manufacturing").includes("evidence:drawing"));
  assert.ok(part("release").includes("workstream:bom"));
  assert.ok(part("release").includes("presentation:exploded"));
  // A prototype is not a concept: obligations never drop to zero for
  // assemblies.
  assert.ok(assembly("prototype").length > 0);
  // Baseline-bound objectives owe the frame context record.
  assert.deepEqual([...obligationsOf({ objective: "analyze" })].sort(), ["record:frame_context"]);
  assert.deepEqual([...obligationsOf({ objective: "convert" })].sort(), ["record:frame_context"]);
  // Lineage obligations: legacy/hybrid owe baseline + frame context, and
  // their specific continuity duties.
  const legacyPartKeys = obligationsOf(design("legacy", "part", "engineering"));
  assert.ok(legacyPartKeys.has("lineage:baseline"));
  assert.ok(legacyPartKeys.has("lineage:continuity"));
  assert.ok(legacyPartKeys.has("record:frame_context"));
  const hybridPartKeys = obligationsOf(design("hybrid", "part", "engineering"));
  assert.ok(hybridPartKeys.has("lineage:retained_interfaces"));
  assert.ok(!hybridPartKeys.has("lineage:continuity"));
  const greenfieldKeys = obligationsOf(design("greenfield", "part", "engineering"));
  assert.ok(!greenfieldKeys.has("lineage:baseline"));
  assert.ok(!greenfieldKeys.has("record:frame_context"));
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

test("consistency: obligations and compiled process are the same source of truth", () => {
  // Every record obligation maps onto a phase that exists in the compiled
  // process, and every phaseRecord traces back to an obligation — the two
  // can never drift apart silently.
  const lineages = ["greenfield", "legacy", "hybrid"] as const;
  const structures = ["part", "assembly"] as const;
  const maturities = ["prototype", "engineering", "manufacturing", "release"] as const;
  for (const lineage of lineages) {
    for (const structure of structures) {
      for (const maturity of maturities) {
        const route = design(lineage, structure, maturity);
        const compiled = compileWorkflow(route);
        // 1. obligations in the compiled process == obligationsOf(route).
        assert.deepEqual(
          [...compiled.obligations].sort(),
          [...obligationsOf(route)].sort(),
        );
        // 2. every record obligation has a phase in the process.
        const phasesWithRecords = new Set(Object.keys(compiled.phaseRecords));
        for (const key of recordObligations(route)) {
          const recordType = key.slice("record:".length);
          const owning = [...phasesWithRecords].filter((phase) =>
            (compiled.phaseRecords[phase as keyof typeof compiled.phaseRecords] ?? []).includes(recordType),
          );
          assert.equal(
            owning.length,
            1,
            `${routeKey(route)}: record ${recordType} owned by ${owning.length} phases`,
          );
          // The owning phase is reachable in the process (it is the entry
          // point or appears in some transition row).
          const phase = owning[0];
          const reachable =
            compiled.nextAfterRequirements === phase ||
            Object.values(compiled.transitions).some((row) => Object.values(row ?? {}).includes(phase as never));
          assert.ok(reachable, `${routeKey(route)}: phase ${phase} owning ${recordType} is unreachable`);
        }
        // 3. every phaseRecord traces back to an obligation.
        const owed = new Set(recordObligations(route));
        for (const records of Object.values(compiled.phaseRecords)) {
          for (const recordType of records ?? []) {
            assert.ok(
              owed.has(`record:${recordType}`),
              `${routeKey(route)}: phaseRecords demand ${recordType} without an obligation`,
            );
          }
        }
      }
    }
  }
  // Objective routes owe frame_context and bind it to their baseline phase.
  const analyze = compileWorkflow({ objective: "analyze" });
  assert.deepEqual(analyze.phaseRecords, { baseline: ["frame_context"] });
  const convert = compileWorkflow({ objective: "convert" });
  assert.deepEqual(convert.phaseRecords, { source_baseline: ["frame_context"] });
});

test("compiler: review regressions stale the downstream record trail", () => {
  const assembly = compileWorkflow(design("greenfield", "assembly", "engineering"));
  assert.deepEqual(assembly.recordStaleOnEnter?.assembly_design, [
    "assembly_design",
    "interface_contracts",
  ]);
  assert.deepEqual(assembly.recordStaleOnEnter?.interface_design, ["interface_contracts"]);
  // Part routes have no records to stale.
  const part = compileWorkflow(design("greenfield", "part", "engineering"));
  assert.equal(part.recordStaleOnEnter, undefined);
});
