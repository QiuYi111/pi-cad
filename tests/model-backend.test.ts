/**
 * ModelBackend contract tests (refactor Phase 5).
 *
 * Proves the dependency direction: workflow code (buildProposal /
 * convertProposal) talks to the ModelBackend interface only. A stub
 * backend drives the full proposal path without any Python, and the
 * real build123d backend passes the same contract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  Build123dBackend,
  DEFAULT_MODEL_BACKEND,
  modelBackend,
  modelBackendIds,
  registerModelBackend,
} from "../src/modules/model/backend.ts";
import { buildProposal, convertProposal } from "../src/modules/model/finalizer.ts";

function stubEnvelope(ok: boolean, artifacts: Array<{ path: string; kind: string; sha256: string }> = []): any {
  return {
    ok,
    tool: "stub_build",
    toolVersion: "0",
    inputHashes: { source: "s" },
    outputHashes: {},
    durationMs: 1,
    warnings: [],
    artifacts,
    payload: ok ? { step: "build/out.step" } : { error: "stub exploded" },
  };
}

test("registry: build123d default, stub registration, duplicate rejection", () => {
  assert.ok(modelBackendIds().includes(DEFAULT_MODEL_BACKEND));
  assert.equal(modelBackend().id, DEFAULT_MODEL_BACKEND);
  assert.ok(modelBackend() instanceof Build123dBackend);

  const stub = {
    id: "stub-test",
    label: "stub",
    build: async () => stubEnvelope(true),
    export: async () => stubEnvelope(true),
  };
  registerModelBackend(stub);
  assert.ok(modelBackendIds().includes("stub-test"));
  assert.throws(() => registerModelBackend(stub), /already registered/);
});

test("contract: buildProposal runs entirely on a stub backend (no python)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-backend-"));
  try {
    mkdirSync(join(cwd, "models"), { recursive: true });
    writeFileSync(join(cwd, "models", "a.py"), "result = Box(1,1,1)");

    const calls: string[] = [];
    const stub = {
      id: "stub-probe",
      label: "stub",
      build: async (_cwd: string, input: { source: string }) => {
        calls.push(`build:${input.source}`);
        return stubEnvelope(true, [
          { path: join(cwd, "build", "a.step"), kind: "step", sha256: "f".repeat(64) },
        ]);
      },
      export: async () => stubEnvelope(true),
    };
    const result = await buildProposal(cwd, "models/a.py", "c1", stub);
    assert.ok(result.ok);
    assert.deepEqual(calls, ["build:models/a.py"]);
    if (result.ok) {
      assert.equal(result.proposal.artifactHash, "f".repeat(64));
      assert.equal(result.proposal.envelope.tool, "stub_build");
    }

    const failed = await buildProposal(cwd, "models/a.py", "c2", {
      id: "stub-fail",
      label: "stub",
      build: async () => stubEnvelope(false),
      export: async () => stubEnvelope(false),
    });
    assert.ok(!failed.ok);
    if (!failed.ok && "buildFailed" in failed) {
      assert.equal(failed.error, "stub exploded");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("contract: convertProposal goes through backend.export", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-backend-"));
  try {
    mkdirSync(join(cwd, "models"), { recursive: true });
    writeFileSync(join(cwd, "models", "a.step"), "ISO-10303-21;");
    const exports: string[] = [];
    const stub = {
      id: "stub-export",
      label: "stub",
      build: async () => stubEnvelope(true),
      export: async (_cwd: string, input: { format: string }) => {
        exports.push(input.format);
        return stubEnvelope(true, [
          { path: join(cwd, "out.stl"), kind: "stl", sha256: "e".repeat(64) },
        ]);
      },
    };
    const result = await convertProposal(cwd, "models/a.step", "c3", "stl", "out.stl", stub);
    assert.ok(result.ok);
    assert.deepEqual(exports, ["stl"]);
    if (result.ok) assert.equal(result.proposal.kind, "convert");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("contract: real build123d backend produces provenance-bound step artifact", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-b123-"));
  try {
    mkdirSync(join(cwd, "models"), { recursive: true });
    writeFileSync(
      join(cwd, "models", "box.py"),
      "import build123d as bd\nresult = bd.Box(10, 10, 10)\n",
    );
    const result = await buildProposal(cwd, "models/box.py", "c4");
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      const envelope = result.proposal.envelope;
      assert.ok(envelope.backendVersion, "backendVersion provenance present");
      assert.ok(result.proposal.artifactHash.match(/^[0-9a-f]{64}$/));
      assert.ok(envelope.artifacts.some((a) => a.kind === "step"), "step artifact bound");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
