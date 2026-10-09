import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { commitMechanicalCandidateV7 } from "../src/domains/mechanical/candidate-actions-v7.ts";
import { commitMechanicalRecordV7, transitionMechanicalRunV7 } from "../src/domains/mechanical/control-actions-v7.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalBuiltinWorkflows } from "../src/domains/mechanical/workflows.ts";
import { cadStart } from "../src/harness/kernel.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";

function registerPublicActions(): void {
  const pi: any = { registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; }, appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} } };
  for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
}

const REQUIREMENTS = { goal: "Two-module bracket", deliverables: ["STEP"], must: ["fits rail"], assertions: [], preferences: [], assumptions: [], openUnknowns: [] };
const ASSEMBLY_DESIGN = {
  summary: "two-module bracket",
  modules: [{ name: "base", purpose: "mounts to rail" }, { name: "arm", purpose: "carries the load" }],
  datums: [{ name: "A", kind: "primary", definedBy: "base bottom face" }],
  sequence: [{ step: 1, installs: ["base"] }],
};
const REVISED_ASSEMBLY_DESIGN = { ...ASSEMBLY_DESIGN, summary: "two-module bracket, arm moved outboard" };
const INTERFACE_CONTRACTS = { contracts: [{ id: "base-arm", a: "base", b: "arm", locating: "pin against datum A", dof: "six constrained", fasteners: "2 x M5", fits: "H7/g6", assemblyDirection: "+Z", toolAccess: "top" }] };
const PLAN = { summary: "two solids", protected: [], plannedChanges: ["build"], interfaces: [], datums: [], reviewPlan: ["visual", "geometry"] };

async function phaseOf(cwd: string): Promise<string | undefined> {
  return (await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries))?.state.phase;
}

async function phaseRecords(cwd: string): Promise<string[]> {
  const run = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  return Object.keys(run!.state.records).sort();
}

// Rule 4: review regressions stale the downstream record trail (v6 recordStaleOnEnter), and a
// revised assembly_design stales the interface_contracts that depend on it.
test("v7 stale records: architecture reroute requires a revised assembly_design, and its revision stales interface_contracts", async () => {
  registerPublicActions();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-stale-"));
  try {
    await mkdir(join(cwd, "models"), { recursive: true });
    await writeFile(join(cwd, "models", "bracket.py"), "import build123d as bd\nresult = bd.Box(20, 12, 5)\n");
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "v7 stale records test" });
    await cadRouteV7({ cwd, route: { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "prototype" }, reason: "stale records" });
    await commitMechanicalRecordV7({ cwd, type: "requirements", value: REQUIREMENTS });
    await transitionMechanicalRunV7({ cwd, event: "direction_selected", note: "topology chosen" });
    await commitMechanicalRecordV7({ cwd, type: "assembly_design", value: ASSEMBLY_DESIGN });
    await commitMechanicalRecordV7({ cwd, type: "interface_contracts", value: INTERFACE_CONTRACTS });
    await commitMechanicalRecordV7({ cwd, type: "plan", value: PLAN });
    const candidate = await commitMechanicalCandidateV7({ cwd, sources: ["models/bracket.py"], label: "bracket-v1" });
    assert.equal(candidate.loaded.state.phase, "integration_review");

    // (a) An architecture issue sends the run back to assembly_design with the old trail stale.
    await transitionMechanicalRunV7({ cwd, event: "architecture_issue", note: "module split wrong" });
    assert.deepEqual(await phaseRecords(cwd), ["record:plan:part_design", "record:requirements"], "assembly_design and interface_contracts are stale");
    await assert.rejects(transitionMechanicalRunV7({ cwd, event: "assembly_design_committed", note: "reuse the stale record" }), /record:assembly_design:assembly_design/);

    // The revised record completes the phase, and the contracts are committed again behind it.
    const revised = await commitMechanicalRecordV7({ cwd, type: "assembly_design", value: REVISED_ASSEMBLY_DESIGN });
    assert.equal(revised.state.phase, "interface_design");
    await commitMechanicalRecordV7({ cwd, type: "interface_contracts", value: INTERFACE_CONTRACTS });
    assert.equal(await phaseOf(cwd), "part_design");
    assert.deepEqual(await phaseRecords(cwd), ["record:assembly_design:assembly_design", "record:interface_contracts:interface_design", "record:plan:part_design", "record:requirements"]);

    // (b) Revising assembly_design stales the interface_contracts that depend on it.
    await commitMechanicalRecordV7({ cwd, type: "assembly_design", value: ASSEMBLY_DESIGN, revise: true });
    assert.deepEqual(await phaseRecords(cwd), ["record:assembly_design:assembly_design", "record:plan:part_design", "record:requirements"], "interface_contracts is stale");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
