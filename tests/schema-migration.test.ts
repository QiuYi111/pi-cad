import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CadProjectStore, hashRecord } from "../src/shared/store.ts";

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

test("schema migration chain v3->v6: active run aborts with an event, head untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-mig-active-"));
  try {
    await writeLayout(cwd, v3Run());
    const store = new CadProjectStore(cwd);
    assert.equal(await store.migrate(), true);

    // Project head survives byte-for-byte in meaning.
    const project = await store.loadProject();
    assert.ok(project);
    assert.equal(project?.schemaVersion, 6);
    assert.equal(project?.head.artifactPath, "build/bracket.step");
    assert.equal(project?.head.artifactHash, "artifact-hash");
    assert.equal(project?.currentRunId, "run-001");

    // The active run is aborted at v4 with route null (no lossy mapping).
    const statePath = join(cwd, ".pi-cad", "runs", "run-001", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(state.schemaVersion, 6);
    assert.equal(state.status, "aborted");
    assert.equal(state.workflow, undefined);
    assert.equal(state.route, null);

    // The journal records why.
    const events = readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "events.jsonl"), "utf-8");
    assert.match(events, /RunAbortedBySchemaMigration/);
    assert.match(events, /cad_route/);

    // Migration is idempotent.
    assert.equal(await store.migrate(), false);

    // The aborted run is not an active workflow: guard-style load returns it
    // but downstream guards see "aborted".
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded?.status, "aborted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema migration chain: finished v3 runs keep their terminal status", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-mig-done-"));
  try {
    await writeLayout(cwd, v3Run({ status: "done", phase: "done", workflow: "quick" }));
    const store = new CadProjectStore(cwd);
    assert.equal(await store.migrate(), true);
    const state = JSON.parse(
      readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"),
    );
    assert.equal(state.schemaVersion, 6);
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
      await store.migrate();
      const state = JSON.parse(
        readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"),
      );
      assert.equal(state.status, "aborted", status);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("schema migration v4->v5 aborts active simulation workflows and preserves terminal history/head", async () => {
  for (const status of ["active", "done"]) {
    const cwd = mkdtempSync(join(tmpdir(), `pi-cad-mig-v4-${status}-`));
    try {
      const project = { ...v3Project(), schemaVersion: 4 };
      const run = { ...v3Run({ schemaVersion: 4, status, route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" } }) };
      delete (run as Record<string, unknown>).workflow;
      delete (run as Record<string, unknown>).maturity;
      await writeLayout(cwd, run, project);
      const store = new CadProjectStore(cwd);
      assert.equal(await store.migrateV4ToV5(), true);
      const migrated = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"));
      assert.equal(migrated.schemaVersion, 5);
      assert.equal(migrated.status, status === "active" ? "aborted" : "done");
      const head = JSON.parse(readFileSync(join(cwd, ".pi-cad", "project.json"), "utf-8"));
      assert.equal(head.head.artifactHash, "artifact-hash");
      const eventPath = join(cwd, ".pi-cad", "runs", "run-001", "events.jsonl");
      assert.equal(existsSync(eventPath), status === "active");
      if (status === "active") assert.match(readFileSync(eventPath, "utf-8"), /Simulation V2/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("schema migration v5->v6 preserves active and terminal runs while materializing requirements", async () => {
  const requirements = {
    goal: "legacy v5 contract", deliverables: ["STEP"], must: [], assertions: [],
    preferences: [], assumptions: [], openUnknowns: [],
  };
  for (const status of ["active", "done"] as const) {
    const cwd = mkdtempSync(join(tmpdir(), `pi-cad-mig-v5-${status}-`));
    try {
      const project = { ...v3Project(), schemaVersion: 5 };
      const run = {
        ...v3Run({ schemaVersion: 5, status, route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" } }),
        requirementsVersion: hashRecord(requirements),
      };
      delete (run as Record<string, unknown>).workflow;
      delete (run as Record<string, unknown>).maturity;
      await writeLayout(cwd, run, project);
      mkdirSync(join(cwd, ".pi-cad", "runs", "run-001", "records"), { recursive: true });
      writeFileSync(join(cwd, ".pi-cad", "runs", "run-001", "records", "requirements.json"), JSON.stringify(requirements));
      const store = new CadProjectStore(cwd);
      assert.equal(await store.migrateV5ToV6(), true);
      const migrated = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"));
      assert.equal(migrated.schemaVersion, 6);
      assert.equal(migrated.status, status);
      assert.ok(existsSync(join(cwd, ".pi-cad", "runs", "run-001", "records", "requirements", `${hashRecord(requirements)}.json`)));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("schema migration v5->v6 never clears an external requirements-related blocker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-mig-v5-external-blocker-"));
  try {
    const project = { ...v3Project(), schemaVersion: 5 };
    const externalBlocker = {
      type: "external_input",
      reason: "requirements revision baseline is still being delivered",
      needed: "wait for the replacement STEP",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const run = {
      ...v3Run({ schemaVersion: 5, status: "blocked_external", blocker: externalBlocker }),
      route: { objective: "design", lineage: "legacy", structure: "part", maturity: "prototype" },
    };
    delete (run as Record<string, unknown>).workflow;
    delete (run as Record<string, unknown>).maturity;
    await writeLayout(cwd, run, project);
    const store = new CadProjectStore(cwd);
    assert.equal(await store.migrateV5ToV6(), true);
    const migrated = JSON.parse(readFileSync(join(cwd, ".pi-cad", "runs", "run-001", "state.json"), "utf-8"));
    assert.equal(migrated.status, "blocked_external");
    assert.deepEqual(migrated.blocker, externalBlocker);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
