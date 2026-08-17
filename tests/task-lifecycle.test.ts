import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CadProjectStore } from "../src/shared/store.ts";
import { createIntakeState } from "../src/core/state-machine.ts";

test("project supports multiple tasks with thin current.json and parent references", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-lifecycle-"));
  try {
    const project = new CadProjectStore(cwd);
    const first = await project.createTask();
    const firstState = createIntakeState({ taskId: first.taskId });
    firstState.workflow = "greenfield";
    firstState.phase = "done";
    firstState.status = "done";
    firstState.currentSourcePath = "models/planetary.py";
    firstState.currentArtifactPath = "build/planetary.step";
    await first.save(firstState);

    assert.equal(await project.currentTaskId(), first.taskId);
    assert.equal(existsSync(join(cwd, ".pi-cad", "current.json")), true);
    assert.equal(existsSync(join(cwd, ".pi-cad", "state.json")), false);

    const second = await project.createTask({ parentTaskId: first.taskId });
    const secondState = createIntakeState({ taskId: second.taskId, parentTaskId: first.taskId });
    await second.save(secondState);
    assert.equal(await project.currentTaskId(), second.taskId);

    const tasks = await project.listTasks();
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find((t) => t.taskId === second.taskId)?.parentTaskId, first.taskId);
    assert.equal(tasks.find((t) => t.taskId === first.taskId)?.phase, "done");

    const current = JSON.parse(readFileSync(join(cwd, ".pi-cad", "current.json"), "utf-8"));
    assert.deepEqual(current, { activeTaskId: second.taskId });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy V0 single-state layout migrates into a task directory", async () => {
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
    };
    writeFileSync(join(cwd, ".pi-cad", "state.json"), JSON.stringify(legacy));
    writeFileSync(join(cwd, ".pi-cad", "events.jsonl"), '{"at":"2026-08-17T00:00:00Z","type":"Finished"}\n');
    mkdirSync(join(cwd, ".pi-cad", "records"));

    const project = new CadProjectStore(cwd);
    assert.equal(await project.migrateLegacyProject(), true);
    const taskId = await project.currentTaskId();
    assert.ok(taskId);
    assert.ok(taskId.startsWith("cad-legacy-"));
    const task = await project.task(taskId!);
    const migrated = await task.load();
    assert.equal(migrated?.schemaVersion, 3);
    assert.equal(migrated?.phase, "done");
    assert.equal(existsSync(join(cwd, ".pi-cad", "state.json")), false);
    assert.ok(task.eventsPath.endsWith("events.jsonl"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
