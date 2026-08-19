import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CadProjectStore } from "../src/shared/store.ts";

function v3Project() {
  return {
    schemaVersion: 3,
    projectId: "legacy",
    head: {
      sourcePath: "models/bracket.py",
      sourceHash: "source-hash",
      artifactPath: "build/bracket.step",
      artifactHash: "artifact-hash",
      evidence: [],
      updatedAt: "2026-01-01T00:00:00Z",
    },
    currentRunId: "run-001",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function v3Run(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    runId: "run-001",
    projectId: "legacy",
    createdAt: "2026-01-01T00:00:00Z",
    workflow: "greenfield",
    phase: "build",
    status: "active",
    maturity: "prototype",
    mutationPolicy: "source_only",
    evidence: [],
    staleEvidence: [],
    activeWorkstreams: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function writeLayout(cwd: string, run: unknown, project = v3Project()) {
  mkdirSync(join(cwd, ".pi-cad", "runs", "run-001"), { recursive: true });
  writeFileSync(join(cwd, ".pi-cad", "project.json"), JSON.stringify(project));
  writeFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), JSON.stringify(run));
}

test("schema migration v3->v4: active run aborts with an event, head untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-mig-active-"));
  try {
    await writeLayout(cwd, v3Run());
    const store = new CadProjectStore(cwd);
    assert.equal(await store.migrateV3ToV4(), true);

    // Project head survives byte-for-byte in meaning.
    const project = await store.loadProject();
    assert.ok(project);
    assert.equal(project?.schemaVersion, 4);
    assert.equal(project?.head.artifactPath, "build/bracket.step");
    assert.equal(project?.head.artifactHash, "artifact-hash");
    assert.equal(project?.currentRunId, "run-001");

    // The active run is aborted at v4 with route null (no lossy mapping).
    const statePath = join(cwd, ".pi-cad", "runs", "run-001", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.status, "aborted");
    assert.equal(state.workflow, undefined);
    assert.equal(state.route, null);

    // The journal records why.
    const events = readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "events.jsonl"), "utf-8");
    assert.match(events, /RunAbortedBySchemaMigration/);
    assert.match(events, /cad_route/);

    // Migration is idempotent.
    assert.equal(await store.migrateV3ToV4(), false);

    // The aborted run is not an active workflow: guard-style load returns it
    // but downstream guards see "aborted".
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded?.status, "aborted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema migration v3->v4: finished runs keep their terminal status", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-mig-done-"));
  try {
    await writeLayout(cwd, v3Run({ status: "done", phase: "done", workflow: "quick" }));
    const store = new CadProjectStore(cwd);
    assert.equal(await store.migrateV3ToV4(), true);
    const state = JSON.parse(
      readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"),
    );
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.status, "done");
    assert.equal(state.route, null);
    assert.ok(!existsSync(join(cwd, ".pi-cad", "runs", "run-001", "events.jsonl")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema migration: waiting_user and ready runs also abort", async () => {
  for (const status of ["waiting_user", "ready"]) {
    const cwd = mkdtempSync(join(tmpdir(), `pi-cad-mig-${status}-`));
    try {
      await writeLayout(cwd, v3Run({ status }));
      const store = new CadProjectStore(cwd);
      await store.migrateV3ToV4();
      const state = JSON.parse(
        readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"),
      );
      assert.equal(state.status, "aborted", status);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
