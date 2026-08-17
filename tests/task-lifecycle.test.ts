import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CadProjectStore } from "../src/shared/store.ts";
import { createIntakeState } from "../src/core/state-machine.ts";

test("project head persists across runs and current run can return to idle", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-project-runs-"));
  try {
    const project = new CadProjectStore(cwd);
    const first = await project.createRun();
    const firstState = createIntakeState({ runId: first.runId, projectId: project.projectId });
    firstState.workflow = "greenfield";
    firstState.phase = "done";
    firstState.status = "done";
    firstState.currentSourcePath = "models/planetary.py";
    firstState.currentSourceHash = "source-hash";
    firstState.currentArtifactPath = "build/planetary.step";
    firstState.currentArtifactHash = "artifact-hash";
    await first.save(firstState);
    await project.updateHead({
      sourcePath: firstState.currentSourcePath,
      sourceHash: firstState.currentSourceHash,
      artifactPath: firstState.currentArtifactPath,
      artifactHash: firstState.currentArtifactHash,
      evidence: firstState.evidence,
    });
    await project.setCurrentRun(null);

    const projectState = await project.loadProject();
    assert.equal(projectState?.currentRunId, null);
    assert.equal(projectState?.head.artifactPath, "build/planetary.step");
    assert.equal(projectState?.head.artifactHash, "artifact-hash");
    assert.equal(existsSync(join(cwd, ".pi-cad", "project.json")), true);
    assert.equal(existsSync(join(cwd, ".pi-cad", "current.json")), false);

    const second = await project.createRun();
    assert.equal(await project.currentRunId(), second.runId);
    const runs = await project.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, first.runId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy V0 single-state layout migrates into project + runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-migrate-"));
  try {
    mkdirSync(join(cwd, ".pi-cad"), { recursive: true });
    const legacy = {
      schemaVersion: 2,
      taskId: "legacy-task",
      workflow: "quick",
      phase: "done",
      status: "done",
      maturity: "prototype",
      mutationPolicy: "read_only",
      evidence: [],
      staleEvidence: [],
      activeWorkstreams: [],
      updatedAt: "2026-08-17T00:00:00Z",
      currentSourcePath: "models/plate.py",
      currentSourceHash: "source-hash",
      currentArtifactPath: "build/plate.step",
      currentArtifactHash: "artifact-hash",
    };
    writeFileSync(join(cwd, ".pi-cad", "state.json"), JSON.stringify(legacy));
    writeFileSync(join(cwd, ".pi-cad", "events.jsonl"), '{"at":"2026-08-17T00:00:00Z","type":"Finished"}\n');
    mkdirSync(join(cwd, ".pi-cad", "records"));

    const project = new CadProjectStore(cwd);
    assert.equal(await project.migrateLegacyProject(), true);
    const projectState = await project.loadProject();
    assert.ok(projectState);
    assert.equal(projectState?.currentRunId, null);
    assert.equal(projectState?.head.artifactPath, "build/plate.step");
    assert.equal(existsSync(join(cwd, ".pi-cad", "state.json")), false);
    const runs = await project.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].phase, "done");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
