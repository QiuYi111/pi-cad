/**
 * PhaseContract tests (refactor Phase 7).
 *
 * The phase-0 golden matrix already proves compiled tool lists equal
 * the legacy hardcoded lists. These tests pin the contract layer
 * itself: total coverage, grant mapping, and the control-plane
 * dependency rule (no backend imports).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  allPhaseContracts,
  capabilityTools,
  contractTools,
  phaseContract,
} from "../src/control/phase-contract.ts";
import { CAD_PHASES } from "../src/shared/protocol.ts";
import { toolsForPhase } from "../src/core/policies.ts";

test("contracts: every phase has a contract with at least one grant", () => {
  const contracts = allPhaseContracts();
  assert.equal(contracts.length, CAD_PHASES.length);
  for (const contract of contracts) {
    assert.ok(contract.grants.length > 0, `${contract.phase} has grants`);
  }
});

test("contracts: tools compile without duplicates", () => {
  for (const contract of allPhaseContracts()) {
    const tools = contractTools(contract);
    assert.equal(new Set(tools).size, tools.length, `${contract.phase} duplicates`);
  }
});

test("contracts: compiled tool sets equal the golden sets for every phase", () => {
  // The pre-contract audit list contained every COGNITIVE inspection tool
  // twice (COGNITIVE_TOOLS + CAPABILITY_TOOLS concatenation). Phase 7
  // deduped it; every compiled SET must equal the golden SET (reroute
  // attachment included, via toolsForPhase).
  const golden = JSON.parse(
    readFileSync(new URL("./fixtures/phase0-golden.json", import.meta.url), "utf8"),
  ) as { toolsForPhase: Record<string, string[]> };
  for (const [phase, tools] of Object.entries(golden.toolsForPhase)) {
    const expected = new Set(toolsForPhase(phase as never));
    for (const tool of tools) assert.ok(expected.has(tool), `${phase}: ${tool} missing from contract`);
    for (const tool of expected) assert.ok(tools.includes(tool), `${phase}: ${tool} extra in contract`);
  }
});

test("contracts: capability grants map to the expected tool families", () => {
  assert.deepEqual(capabilityTools("observe"), [
    "cad_probe",
    "cad_inspect_visual",
    "cad_inspect_geometry",
    "cad_inspect_surfaces",
    "cad_inspect_section",
    "cad_measure",
    "cad_compare_geometry",
    "cad_assembly_tree",
    "cad_scan_sections",
  ]);
  assert.deepEqual(capabilityTools("simulate"), [
    "cad_simulate",
    "cad_simulate_flow",
    "cad_simulate_thermal",
  ]);
  assert.deepEqual(capabilityTools("model_build"), ["cad_build_step"]);
  assert.ok(capabilityTools("deliverable").includes("cad_generate_drawing"));
});

test("contracts: source phases never grant simulate/optimize; review does", () => {
  const build = phaseContract("build").grants;
  assert.ok(!build.includes("simulate"));
  assert.ok(!build.includes("optimize"));
  const review = phaseContract("review").grants;
  assert.ok(review.includes("simulate"));
  assert.ok(review.includes("observe_programmable"));
  const plan = phaseContract("plan").grants;
  assert.ok(!plan.includes("observe_interference"), "cognitive phases have no interference");
  const ready = phaseContract("ready").grants;
  assert.ok(ready.includes("finish"));
  assert.ok(!ready.includes("optimize"));
});

test("contracts: control plane has zero backend imports", async () => {
  const source = readFileSync(new URL("../src/control/phase-contract.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("cadctl"));
  assert.ok(!source.includes("build123d"));
  assert.ok(!source.includes("capability.ts"));
  assert.ok(!source.includes("execFile"));
});
