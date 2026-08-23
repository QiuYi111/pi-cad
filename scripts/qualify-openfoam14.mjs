#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createIntakeState } = await jiti.import("../src/core/state-machine.ts");
const { commitSimulation } = await jiti.import("../src/extensions/simulation/v2.ts");
const { managedSimulationRunner } = await jiti.import("../src/modules/simulate-v2/runtime.ts");
const { createSimulationRun } = await jiti.import("../src/modules/simulate-v2/store.ts");
const { CadProjectStore, sha256File } = await jiti.import("../src/shared/store.ts");

const project = await mkdtemp(join(tmpdir(), "pi-cad-openfoam14-qualification-"));
try {
  const recipe = join(project, "simulation", "openfoam14-box");
  await mkdir(join(project, "simulation"), { recursive: true });
  await cp(join(root, "benchmarks", "simulation-v2", "openfoam14-box"), recipe, { recursive: true });
  const store = new CadProjectStore(project);
  const workflow = await store.createRun({ runId: "qualification-001" });
  const domainPath = join(recipe, "domain.step");
  await workflow.save({
    ...createIntakeState({ runId: "qualification-001", projectId: store.projectId }),
    currentArtifactPath: "simulation/openfoam14-box/domain.step",
    currentArtifactHash: await sha256File(domainPath),
    evidenceObligations: { simulation: { disposition: "required", cases: [{ id: "openfoam14-box-qualification", tool: "cad_simulate" }] } },
  });
  process.env.PI_CAD_QUALIFICATION_SECRET = "must-not-cross-runtime-boundary";
  const isolation = await managedSimulationRunner.execute({
    cwd: project,
    workspace: project,
    recipeDirectory: recipe,
    command: "if env | grep -q PI_CAD_QUALIFICATION_SECRET; then exit 91; fi; test ! -e /mnt/c; test ! -e /home/jingyi/pi-cad; if getent hosts example.com >/dev/null 2>&1; then exit 92; fi; foamVersion",
    environment: { PI_SIM_RUN_ID: "isolation-probe" },
    stdoutPath: join(project, "isolation-stdout.log"),
    stderrPath: join(project, "isolation-stderr.log"),
    timeoutMs: 30_000,
    backend: "openfoam",
    runtime: "openfoam-14",
  });
  delete process.env.PI_CAD_QUALIFICATION_SECRET;
  assert.equal(isolation.exitCode, 0, JSON.stringify(isolation));
  const result = await createSimulationRun({
    cwd: project,
    backend: "openfoam",
    runtime: "openfoam-14",
    recipePath: "simulation/openfoam14-box",
    outputs: ["refinement", "qualification_report", "interface_animation"],
    runner: managedSimulationRunner,
  });
  assert.equal(result.run.status, "completed", JSON.stringify(result.run.entrypoint));
  assert.equal(result.observation?.validForCommit, true, JSON.stringify(result.observation));
  const reportExport = result.validatedObservation?.selected.find((entry) => entry.name === "qualification_report");
  assert.ok(reportExport?.absolutePath, "qualification_report export missing");
  const report = JSON.parse(await readFile(reportExport.absolutePath, "utf-8"));
  assert.equal(report.qualified, true, JSON.stringify(report));
  assert.deepEqual((await store.load())?.evidence, [], "qualification solve must not create Evidence implicitly");
  const evidence = await commitSimulation(project, result.run.runId, result.observation.observationId, "openfoam14-box-qualification");
  assert.equal((await store.load())?.evidence.length, 1, "explicit commit must create exactly one EvidenceRef");
  const qualificationRoot = join(root, ".pi-cad", "qualifications", "openfoam14");
  await rm(qualificationRoot, { recursive: true, force: true });
  await mkdir(qualificationRoot, { recursive: true });
  await cp(result.observationDirectory, join(qualificationRoot, "observation"), { recursive: true });
  const durableReport = {
    schema: 1,
    qualifiedAt: new Date().toISOString(),
    qualified: true,
    simulationRunId: result.run.runId,
    observationId: result.observation.observationId,
    runtimeIdentity: result.run.runtimeIdentity,
    evidenceId: evidence.id,
    checks: report.checks,
    limits: report.limits,
    observationSnapshot: "observation/snapshot.json",
    provenanceManifest: "observation/provenance-manifest.json",
  };
  await writeFile(join(qualificationRoot, "qualification-report.json"), `${JSON.stringify(durableReport, null, 2)}\n`);
  console.log(JSON.stringify({
    qualified: true,
    simulationRunId: result.run.runId,
    observationId: result.observation.observationId,
    runtimeIdentity: result.run.runtimeIdentity,
    evidenceId: evidence.id,
    checks: report.checks,
    qualificationReport: join(qualificationRoot, "qualification-report.json"),
  }, null, 2));
} finally {
  await rm(project, { recursive: true, force: true });
}
