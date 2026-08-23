#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { buildStep, inspectSurfaces } = await jiti.import("../src/shared/capability.ts");
const { createIntakeState } = await jiti.import("../src/core/state-machine.ts");
const { commitSimulation } = await jiti.import("../src/extensions/simulation/v2.ts");
const { createSimulationRun } = await jiti.import("../src/modules/simulate-v2/store.ts");
const { managedSimulationRunner } = await jiti.import("../src/modules/simulate-v2/runtime.ts");
const { CadProjectStore, sha256File } = await jiti.import("../src/shared/store.ts");

async function prepareWorkflow(project, runId, artifact, caseId) {
  const store = new CadProjectStore(project);
  const workflow = await store.createRun({ runId });
  await workflow.save({
    ...createIntakeState({ runId, projectId: store.projectId }),
    currentArtifactPath: artifact,
    currentArtifactHash: await sha256File(join(project, artifact)),
    evidenceObligations: { simulation: { disposition: "required", cases: [{ id: caseId, tool: "cad_simulate" }] } },
  });
  return store;
}

async function runRecipe(project, recipePath, artifact, caseId, workflowRunId) {
  const store = await prepareWorkflow(project, workflowRunId, artifact, caseId);
  const result = await createSimulationRun({
    cwd: project,
    backend: "su2",
    runtime: "su2-8.5.0",
    recipePath,
    outputs: ["convergence", "fields"],
    runner: managedSimulationRunner,
  });
  assert.equal(result.run.status, "completed", JSON.stringify(result.run.entrypoint));
  assert.equal(result.observation?.validForCommit, true, JSON.stringify(result.observation));
  assert.deepEqual((await store.load())?.evidence, [], "SU2 solve/observe must not create Evidence");
  const evidence = await commitSimulation(project, result.run.runId, result.observation.observationId, caseId);
  assert.equal((await store.load())?.evidence.length, 1, "SU2 explicit commit must create Evidence");
  const rawResult = JSON.parse(await readFile(join(result.runDirectory, "raw-project", recipePath, "result.json"), "utf8"));
  return { result, evidence, rawResult };
}

async function qualifyThermal(base) {
  const project = join(base, "thermal");
  await mkdir(join(project, "build"), { recursive: true });
  await mkdir(join(project, "simulation"), { recursive: true });
  const recipePath = "simulation/su2-solid-thermal";
  await cp(join(root, "skills", "thermal-fluid-analysis", "assets", "recipes", "su2-solid-thermal"), join(project, recipePath), { recursive: true });
  const built = await buildStep(project, { source: join(root, "tests", "fixtures", "slab.py"), output: join(project, "build", "thermal-solid.step"), force: true });
  assert.equal(built.ok, true, JSON.stringify(built.payload));
  const surfaces = await inspectSurfaces(project, "build/thermal-solid.step");
  assert.equal(surfaces.ok, true, JSON.stringify(surfaces.payload));
  const facts = surfaces.payload.surfaces;
  const hot = facts.find((item) => item.normal?.[2] === -1)?.id;
  const cold = facts.find((item) => item.normal?.[2] === 1)?.id;
  assert.ok(hot && cold, "thermal qualification could not resolve slab end surfaces");
  const caseData = {
    caseId: "su2-thermal-slab",
    artifact: "../../build/thermal-solid.step",
    geometryUnits: "mm",
    material: { conductivityWPerMK: 16.2 },
    boundaries: [
      { type: "temperature", surfaces: [hot], temperatureK: 1150 },
      { type: "temperature", surfaces: [cold], temperatureK: 300 },
    ],
    mesh: { maxSizeMm: 25 },
    convergence: { maxIterations: 3000, residualTarget: -9 },
  };
  await writeFile(join(project, recipePath, "case.json"), `${JSON.stringify(caseData, null, 2)}\n`);
  const qualified = await runRecipe(project, recipePath, "build/thermal-solid.step", caseData.caseId, "qualification-thermal");
  assert.equal(qualified.rawResult.status, "solved");
  const analyticHeatRateW = 16.2 * 0.01 * 850 / 0.5;
  const hotRate = Math.abs(qualified.rawResult.boundaries[hot].reconstructedHeatRateW);
  const coldRate = Math.abs(qualified.rawResult.boundaries[cold].reconstructedHeatRateW);
  assert.ok(Math.abs(hotRate - analyticHeatRateW) / analyticHeatRateW < 0.06, `${hotRate} vs ${analyticHeatRateW}`);
  assert.ok(Math.abs(coldRate - analyticHeatRateW) / analyticHeatRateW < 0.06, `${coldRate} vs ${analyticHeatRateW}`);
  return {
    runtimeIdentity: qualified.result.run.runtimeIdentity,
    evidenceId: qualified.evidence.id,
    analyticHeatRateW,
    hotRateW: hotRate,
    coldRateW: coldRate,
    energyImbalance: qualified.rawResult.energyBalance.relativeReconstructedImbalance,
  };
}

async function qualifyFlow(base) {
  const project = join(base, "flow");
  await mkdir(join(project, "build"), { recursive: true });
  await mkdir(join(project, "simulation"), { recursive: true });
  const recipePath = "simulation/su2-steady-flow";
  await cp(join(root, "skills", "thermal-fluid-analysis", "assets", "recipes", "su2-steady-flow"), join(project, recipePath), { recursive: true });
  const built = await buildStep(project, { source: join(root, "tests", "fixtures", "nozzle.py"), output: join(project, "build", "fluid-domain.step"), force: true });
  assert.equal(built.ok, true, JSON.stringify(built.payload));
  const surfaces = await inspectSurfaces(project, "build/fluid-domain.step");
  assert.equal(surfaces.ok, true, JSON.stringify(surfaces.payload));
  const facts = surfaces.payload.surfaces;
  const inlet = facts.find((item) => item.type === "plane" && Math.abs(item.centroid[0]) < 1e-9)?.id;
  const outlet = facts.find((item) => item.type === "plane" && Math.abs(item.centroid[0] - 320) < 1e-6)?.id;
  const walls = facts.filter((item) => item.id !== inlet && item.id !== outlet).map((item) => item.id);
  assert.ok(inlet && outlet && walls.length, "flow qualification could not resolve nozzle surfaces");
  const caseData = {
    caseId: "su2-nozzle-flow",
    fluidDomain: "../../build/fluid-domain.step",
    geometryUnits: "mm",
    physics: { type: "compressible_euler" },
    fluid: { model: "ideal_gas", gamma: 1.4, gasConstantJPerKgK: 287.05 },
    initial: { mach: 0.25, temperatureK: 288.15, pressurePa: 101325 },
    boundaries: [
      { type: "total_conditions_inlet", surfaces: [inlet], totalPressurePa: 420000, totalTemperatureK: 1150, flowDirection: [1, 0, 0] },
      { type: "pressure_outlet", surfaces: [outlet], staticPressurePa: 101325 },
      { type: "wall", surfaces: walls, thermal: "adiabatic" },
    ],
    mesh: { maxSizeMm: 14, minSizeMm: 5 },
    convergence: { maxIterations: 1500, residualTarget: -6 },
  };
  await writeFile(join(project, recipePath, "case.json"), `${JSON.stringify(caseData, null, 2)}\n`);
  const qualified = await runRecipe(project, recipePath, "build/fluid-domain.step", caseData.caseId, "qualification-flow");
  assert.equal(qualified.rawResult.status, "solved");
  const massImbalance = qualified.rawResult.massBalance.relativeImbalance;
  const outletMach = qualified.rawResult.boundaries[outlet].areaWeightedMean_Mach;
  assert.ok(massImbalance < 0.05, JSON.stringify(qualified.rawResult.massBalance));
  assert.ok(outletMach > 1 && outletMach < 3, `outlet Mach ${outletMach}`);
  return {
    runtimeIdentity: qualified.result.run.runtimeIdentity,
    evidenceId: qualified.evidence.id,
    massImbalance,
    outletMach,
    convergence: qualified.rawResult.convergence,
  };
}

const base = await mkdtemp(join(tmpdir(), "pi-cad-su2-qualification-"));
try {
  const thermal = await qualifyThermal(base);
  const flow = await qualifyFlow(base);
  const report = { schema: 1, qualifiedAt: new Date().toISOString(), status: "pass", thermal, flow };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputDir = join(root, ".pi-cad", "qualifications", "su2-8.5.0");
  await mkdir(outputDir, { recursive: true });
  const reportPath = join(outputDir, "qualification-report.json");
  await writeFile(reportPath, serialized);
  console.log(JSON.stringify({ status: "pass", report: reportPath, reportSha256: createHash("sha256").update(serialized).digest("hex"), thermal, flow }));
} finally {
  if (!process.env.PI_CAD_KEEP_QUALIFICATION_WORKSPACE) await rm(base, { recursive: true, force: true });
  else console.error(`preserved qualification workspace: ${base}`);
}
