import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import core from "../src/extensions/core/index.ts";
import drawing from "../src/extensions/drawing/index.ts";
import geometry from "../src/extensions/geometry/index.ts";
import presentation from "../src/extensions/presentation/index.ts";
import probe from "../src/extensions/probe/index.ts";
import simulation from "../src/extensions/simulation/index.ts";
import { cadRouteV7 } from "../src/domains/mechanical/actions-v7.ts";
import { commitMechanicalRecordV7, transitionMechanicalRunV7 } from "../src/domains/mechanical/control-actions-v7.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalBuiltinWorkflows, mechanicalWorkflowDefinition } from "../src/domains/mechanical/workflows.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { createHarnessRunState, finishRun, transitionDenialReason, unmetWorkflowObligations } from "../src/harness/reducer.ts";
import { cadStart } from "../src/harness/kernel.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import type { Route } from "../src/shared/route.ts";

function registerActions(): void {
  const pi: any = {
    registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} },
  };
  for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
}

const REQUIREMENTS = { goal: "Two-module bracket", deliverables: ["STEP"], must: ["fits rail"], assertions: [], preferences: [], assumptions: [], openUnknowns: [] };
const ASSEMBLY_DESIGN = {
  summary: "two-module bracket",
  modules: [{ name: "base", purpose: "mounts to rail" }, { name: "arm", purpose: "carries the load" }],
  datums: [{ name: "A", kind: "primary", definedBy: "base bottom face" }],
  sequence: [{ step: 1, installs: ["base"] }],
};
const INTERFACE_CONTRACTS = { contracts: [{ id: "base-arm", a: "base", b: "arm", locating: "pin against datum A", dof: "six constrained", fasteners: "2 x M5", fits: "H7/g6", assemblyDirection: "+Z", toolAccess: "top" }] };
const PLAN = { summary: "two solids", protected: [], plannedChanges: ["build"], interfaces: [], datums: [], reviewPlan: ["visual", "geometry"] };

async function withRun<T>(route: Route, body: (cwd: string) => Promise<T>): Promise<T> {
  registerActions();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-rules-"));
  try {
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "v7 rules test" });
    await cadRouteV7({ cwd, route, reason: "v7 rules test" });
    return await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function phaseOf(cwd: string): Promise<string | undefined> {
  return (await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries))?.state.phase;
}

// Rule 2: assembly design record gating (cad_transition cannot bypass records).
test("v7 rules: assembly routes owe assembly_design then interface_contracts before build, and events cannot bypass them", async () => {
  await withRun({ objective: "design", lineage: "greenfield", structure: "assembly", maturity: "engineering" }, async (cwd) => {
    await commitMechanicalRecordV7({ cwd, type: "requirements", value: REQUIREMENTS });
    assert.equal(await phaseOf(cwd), "system_concept");
    await transitionMechanicalRunV7({ cwd, event: "direction_selected", note: "topology chosen" });
    assert.equal(await phaseOf(cwd), "assembly_design");

    // Firing the record event without the record fails closed, and a plan is not owed here.
    await assert.rejects(transitionMechanicalRunV7({ cwd, event: "assembly_design_committed", note: "cheat" }), /record:assembly_design:assembly_design/);
    await assert.rejects(commitMechanicalRecordV7({ cwd, type: "plan", value: PLAN }), /expected one current record obligation of type plan/);

    await commitMechanicalRecordV7({ cwd, type: "assembly_design", value: ASSEMBLY_DESIGN });
    assert.equal(await phaseOf(cwd), "interface_design");

    await assert.rejects(transitionMechanicalRunV7({ cwd, event: "interface_contracts_committed", note: "cheat" }), /record:interface_contracts:interface_design/);
    await commitMechanicalRecordV7({ cwd, type: "interface_contracts", value: INTERFACE_CONTRACTS });
    assert.equal(await phaseOf(cwd), "part_design");

    await commitMechanicalRecordV7({ cwd, type: "plan", value: PLAN });
    assert.equal(await phaseOf(cwd), "build");
    const run = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
    assert.deepEqual(Object.keys(run!.state.records).sort(), [
      "record:assembly_design:assembly_design",
      "record:interface_contracts:interface_design",
      "record:plan:part_design",
      "record:requirements",
    ]);
  });
});

// Rule 3: frame-context gate before leaving the baseline (analyze and every baseline-bound route).
test("v7 rules: leaving the baseline requires a committed frame_context record", async () => {
  await withRun({ objective: "analyze" }, async (cwd) => {
    await commitMechanicalRecordV7({ cwd, type: "requirements", value: REQUIREMENTS });
    assert.equal(await phaseOf(cwd), "baseline");
    await assert.rejects(transitionMechanicalRunV7({ cwd, event: "baseline_understood", note: "skipped the frame question" }), /record:frame_context:baseline/);
    assert.equal(await phaseOf(cwd), "baseline");

    await commitMechanicalRecordV7({ cwd, type: "frame_context", value: { disposition: "user_declined", axes: [{ axis: "x", mapsTo: "file +X" }], howConfirmed: "asked; user declined" } });
    assert.equal(await phaseOf(cwd), "baseline", "frame_context is a record, not a transition");
    await transitionMechanicalRunV7({ cwd, event: "baseline_understood", note: "frame confirmed" });
    assert.equal(await phaseOf(cwd), "investigate");
  });
});

// Rule 1: release closure needs presentation deliverables in current evidence (recipe-backed obligation).
test("v7 rules: release closure is blocked until the presentation obligation with its required outputs is met", async () => {
  registerActions();
  const cases: Array<{ structure: "part" | "assembly"; outputs: string[] }> = [
    { structure: "part", outputs: ["hero", "turntable"] },
    { structure: "assembly", outputs: ["hero", "turntable", "exploded", "assembly"] },
  ];
  for (const { structure, outputs } of cases) {
    const route = { objective: "design", lineage: "greenfield", structure, maturity: "release" } as const;
    const workflow = compileWorkflowDefinition(mechanicalWorkflowDefinition(route), mechanicalRegistries);
    const registryContract = buildRegistryContract(mechanicalRegistries);
    const obligation = workflow.phases.package!.evidenceObligations.find((item) => item.ref === "evidence:presentation");
    assert.ok(obligation, `${structure} release package owes presentation evidence`);
    assert.deepEqual([...obligation.requiredOutputs!].sort(), [...outputs].sort());

    const base = createHarnessRunState({ runId: `release-${structure}`, projectId: "project", workflow, registryContract });
    const atPackage = { ...base, phase: "package" as const, status: "active" as const, phaseHistory: ["requirements", "package"] };
    const blocked = transitionDenialReason(atPackage, workflow, "package_prepared");
    assert.match(blocked ?? "", /phase obligations remain unmet: .*evidence:presentation/);

    const evidence = { id: "pres-1", obligationRef: "evidence:presentation", type: "presentation", path: "evidence/pres.json", sha256: "a".repeat(64), workflowHash: workflow.hash, registryContractHash: registryContract.hash, createdAt: new Date(0).toISOString() };
    const withPresentation = { ...atPackage, evidence: [evidence] } as typeof atPackage;
    // The drawing obligation in the same phase is a separate gate; presentation alone must now be satisfied.
    assert.doesNotMatch(transitionDenialReason(withPresentation, workflow, "package_prepared") ?? "", /evidence:presentation/);

    // Finishing a run that visited package also re-checks the obligation.
    const readyWithout = { ...base, phase: "ready" as const, status: "ready" as const, phaseHistory: ["requirements", "package", "final_review", "ready"] } as typeof base;
    assert.throws(() => finishRun(readyWithout, workflow), /evidence:presentation/);
    assert.ok(!unmetWorkflowObligations({ ...readyWithout, evidence: [evidence] } as typeof base, workflow).includes("evidence:presentation"));
  }
});
