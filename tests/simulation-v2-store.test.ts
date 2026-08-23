import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createIntakeState } from "../src/core/state-machine.ts";
import { createObservationSnapshot, createSimulationRun, type SimulationCommandRunner } from "../src/modules/simulate-v2/store.ts";
import { CadProjectStore, sha256File } from "../src/shared/store.ts";
import { commitSimulation } from "../src/extensions/simulation/v2.ts";
import { verifyEvidenceFilesForHash } from "../src/core/evidence.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

class StubRunner implements SimulationCommandRunner {
  computeCalls = 0;
  observeCalls = 0;
  async resolveRuntime(_cwd: string, backend: string, runtime: string) {
    return { backend, runtime, platform: "stub", resolvedVersion: "fixed", digest: "d".repeat(64), launcher: "stub" };
  }
  async execute(input: Parameters<SimulationCommandRunner["execute"]>[0]) {
    if (input.environment.PI_SIM_OBSERVATION_FILE) {
      this.observeCalls += 1;
      await writeFile(join(input.workspace, "phase.png"), PNG);
      await writeFile(join(input.workspace, "history.json"), JSON.stringify({ x: [0, 1], y: [0, 0.75] }));
      await writeFile(input.environment.PI_SIM_OBSERVATION_FILE, JSON.stringify({ schema: 1, exports: {
        phase_distribution: { type: "image", path: "phase.png" },
        fill_fraction: { type: "scalar", value: 0.75, unit: "1" },
        history: { type: "timeseries", path: "history.json" },
      } }));
    } else {
      this.computeCalls += 1;
    }
    return { exitCode: 0, durationMs: 1, stdout: "", stderr: "", diagnostics: [] };
  }
}

const TOML = `schema = 1
entrypoint = "./Allrun"
observe = "uv run --project /opt/pi-cad-runtime/python python observe.py"
nonvisual = false
inputs = ["../../build/domain.step", "../../build/materials.json"]
observation_files = ["observe.py"]

[exports.phase_distribution]
type = "image"
primary = true

[exports.fill_fraction]
type = "scalar"
primary = true
unit = "1"

[exports.history]
type = "timeseries"
primary = false
`;

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-v2-store-"));
  await mkdir(join(cwd, "simulation", "case"), { recursive: true });
  await mkdir(join(cwd, "build"), { recursive: true });
  await writeFile(join(cwd, "build", "domain.step"), "domain");
  await writeFile(join(cwd, "build", "materials.json"), "{\"material\":\"v1\"}");
  await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), TOML);
  await writeFile(join(cwd, "simulation", "case", "Allrun"), "compute-v1");
  await writeFile(join(cwd, "simulation", "case", "observe.py"), "observe-v1");
  const store = new CadProjectStore(cwd);
  const workflow = await store.createRun({ runId: "workflow-001" });
  await workflow.save(createIntakeState({ runId: "workflow-001", projectId: store.projectId }));
  return cwd;
}

test("simulate and re-observe create immutable snapshots without implicit Evidence", async () => {
  const cwd = await fixture();
  const runner = new StubRunner();
  try {
    const first = await createSimulationRun({ cwd, backend: "stub", runtime: "stub-1", recipePath: "simulation/case", outputs: ["history"], runner });
    assert.equal(first.run.status, "completed");
    assert.equal(first.observation?.validForCommit, true);
    assert.equal(runner.computeCalls, 1);
    assert.equal(runner.observeCalls, 1);
    assert.deepEqual((await new CadProjectStore(cwd).load())?.evidence, []);

    const frozenAllrun = join(first.runDirectory, "raw-project", "simulation", "case", "Allrun");
    await writeFile(frozenAllrun, "tampered");
    await assert.rejects(createObservationSnapshot({ cwd, workflowRunId: "workflow-001", runId: first.run.runId, outputs: ["history"], runner }), /raw-project changed/);
    await writeFile(frozenAllrun, "compute-v1");

    await writeFile(join(cwd, "simulation", "case", "observe.py"), "observe-v2");
    const second = await createObservationSnapshot({ cwd, workflowRunId: "workflow-001", runId: first.run.runId, outputs: ["history"], runner });
    assert.notEqual(second.observation?.observationId, first.observation?.observationId);
    assert.equal(runner.computeCalls, 1, "Allrun must not execute during re-observe");
    assert.equal(runner.observeCalls, 2);
    assert.notEqual(first.observation!.observationProgramSnapshotHash, second.observation!.observationProgramSnapshotHash);
    assert.notEqual(first.observation!.observationProgramHash, second.observation!.observationProgramHash);
    assert.ok(first.observation!.observationProgramFiles.some((item) => item.path.endsWith("observe.py")));
    const firstProgram = join(first.runDirectory, "observations", first.observation!.observationId, first.observation!.observationProgramPath, "observe.py");
    const secondProgram = join(first.runDirectory, "observations", second.observation!.observationId, second.observation!.observationProgramPath, "observe.py");
    assert.equal(await readFile(firstProgram, "utf8"), "observe-v1");
    assert.equal(await readFile(secondProgram, "utf8"), "observe-v2");
    const firstImage = first.observation!.exports.find((entry) => entry.name === "phase_distribution")!;
    const secondImage = second.observation!.exports.find((entry) => entry.name === "phase_distribution")!;
    assert.equal(firstImage.contentAddress, `sha256:${firstImage.sha256}`);
    assert.equal(secondImage.contentAddress, firstImage.contentAddress);
    const firstImagePath = join(first.runDirectory, "observations", first.observation!.observationId, firstImage.path!);
    const secondImagePath = join(first.runDirectory, "observations", second.observation!.observationId, secondImage.path!);
    assert.equal((await stat(firstImagePath)).ino, (await stat(secondImagePath)).ino, "unchanged exports should reuse one content-addressed inode");

    const projectStore = new CadProjectStore(cwd);
    const state = (await projectStore.load())!;
    state.currentArtifactPath = "build/domain.step";
    state.currentArtifactHash = await sha256File(join(cwd, "build", "domain.step"));
    state.evidenceObligations = { simulation: { disposition: "required", cases: [{ id: "fill-case", tool: "cad_simulate" }] } };
    await projectStore.save(state);
    const evidence = await commitSimulation(cwd, first.run.runId, first.observation!.observationId, "fill-case", runner);
    assert.equal(evidence.simulationRunId, first.run.runId);
    assert.equal(evidence.observationId, first.observation!.observationId, "an older exact snapshot remains committable after re-observation");
    assert.equal((await projectStore.load())!.evidence.length, 1);
    const replacement = await commitSimulation(cwd, first.run.runId, second.observation!.observationId, "fill-case", runner);
    const committed = (await projectStore.load())!;
    assert.equal(committed.evidence.length, 1);
    assert.equal(committed.staleEvidence.length, 1);
    assert.notEqual(replacement.id, evidence.id);
    assert.ok(second.observation!.exports.find((item) => item.name === "history")!.plotSha256);
    assert.equal(await verifyEvidenceFilesForHash(cwd, committed, committed.currentArtifactHash!, ["simulation"]), null);
    await writeFile(secondProgram, "tampered-observer");
    assert.match((await verifyEvidenceFilesForHash(cwd, committed, committed.currentArtifactHash!, ["simulation"]))!, /artifact/);
    await writeFile(secondProgram, "observe-v2");

    await writeFile(join(cwd, "simulation", "case", "Allrun"), "compute-v2");
    await assert.rejects(createObservationSnapshot({ cwd, workflowRunId: "workflow-001", runId: first.run.runId, runner }), /compute Recipe changed/);
    await writeFile(join(cwd, "simulation", "case", "Allrun"), "compute-v1");
    await writeFile(join(cwd, "build", "materials.json"), "{\"material\":\"v2\"}");
    assert.match((await verifyEvidenceFilesForHash(cwd, committed, committed.currentArtifactHash!, ["simulation"]))!, /declaredInput/);
    await writeFile(join(cwd, "build", "materials.json"), "{\"material\":\"v1\"}");
    await writeFile(join(cwd, "build", "domain.step"), "domain-v2");
    await assert.rejects(createObservationSnapshot({ cwd, workflowRunId: "workflow-001", runId: first.run.runId, runner }), /declared simulation input changed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
