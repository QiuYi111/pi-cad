#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createIntakeState } = await jiti.import("../src/core/state-machine.ts");
const { managedSimulationRunner } = await jiti.import("../src/modules/simulate-v2/runtime.ts");
const { createSimulationRun } = await jiti.import("../src/modules/simulate-v2/store.ts");
const { CadProjectStore } = await jiti.import("../src/shared/store.ts");

const project = await mkdtemp(join(tmpdir(), "pi-cad-openfoam14-qualification-"));
try {
  const recipe = join(project, "simulation", "openfoam14-box");
  await mkdir(join(project, "simulation"), { recursive: true });
  await cp(join(root, "benchmarks", "simulation-v2", "openfoam14-box"), recipe, { recursive: true });
  const store = new CadProjectStore(project);
  const workflow = await store.createRun({ runId: "qualification-001" });
  await workflow.save(createIntakeState({ runId: "qualification-001", projectId: store.projectId }));
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
  console.log(JSON.stringify({
    qualified: true,
    simulationRunId: result.run.runId,
    observationId: result.observation.observationId,
    runtimeIdentity: result.run.runtimeIdentity,
    checks: report.checks,
  }, null, 2));
} finally {
  await rm(project, { recursive: true, force: true });
}
