/**
 * SIMULATE lifecycle tests (refactor Phase 6).
 *
 * A stub adapter drives freeze → execute → hash-resolution → observe
 * without any solver. Real solver behavior stays covered by the
 * simulation-tool/thermal-fluid suites.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  registerSimulateAdapter,
  runSimulationLifecycle,
  simulateAdapter,
  simulateAdapterIds,
} from "../src/modules/simulate/lifecycle.ts";

function envelope(payload: Record<string, unknown>, inputHashes: Record<string, string>) {
  return {
    ok: true,
    tool: "stub_simulate",
    toolVersion: "0",
    inputHashes,
    outputHashes: {},
    durationMs: 3,
    warnings: [],
    artifacts: [],
    payload,
  };
}

test("registry: builtin adapters and duplicate rejection", () => {
  const ids = simulateAdapterIds();
  for (const expected of ["structural", "flow", "thermal"]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
    assert.equal(simulateAdapter(expected).id, expected);
  }
  assert.throws(
    () => registerSimulateAdapter(simulateAdapter("flow")),
    /already registered/,
  );
});

test("lifecycle: freeze → execute → solve observation with images", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-sim-"));
  try {
    const seen: Array<{ stage: string; spec: unknown }> = [];
    registerSimulateAdapter({
      id: "stub-solved",
      specKind: "stub",
      evidenceKind: "simulation",
      async run(_cwd, stage, specPath, _outputDir) {
        seen.push({ stage, spec: JSON.parse(readFileSync(specPath, "utf8")) });
        return envelope(
          {
            status: "solved",
            visualization: { views: [] },
          },
          { spec: "s".repeat(64), artifact: "a".repeat(64) },
        ) as never;
      },
    });

    const result = await runSimulationLifecycle({
      cwd,
      adapter: simulateAdapter("stub-solved"),
      spec: { physics: { type: "linear_elasticity" }, artifact: "build/part.step" },
      subject: { artifactPath: "build/part.step" },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].stage, "run");
    assert.equal((seen[0].spec as { physics: { type: string } }).physics.type, "linear_elasticity");
    assert.equal(result.solved, true);
    assert.equal(result.artifactHash, "a".repeat(64), "envelope artifact hash wins");
    assert.equal(result.specHash, "s".repeat(64));
    assert.deepEqual(result.images, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("lifecycle: override hash from analysis model beats envelope hashes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-sim-"));
  try {
    registerSimulateAdapter({
      id: "stub-override",
      specKind: "stub",
      evidenceKind: "simulation",
      async run() {
        return envelope({ status: "solved" }, { artifact: "a".repeat(64) }) as never;
      },
    });
    const result = await runSimulationLifecycle({
      cwd,
      adapter: simulateAdapter("stub-override"),
      spec: {},
      subject: {
        artifactPath: "build/part.step",
        subjectOverrideHash: "o".repeat(64),
      },
    });
    assert.equal(result.artifactHash, "o".repeat(64));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("lifecycle: fallback input keys then spec hash; unsolved attaches no images", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-sim-"));
  try {
    registerSimulateAdapter({
      id: "stub-fallback",
      specKind: "stub",
      evidenceKind: "simulation",
      async run() {
        return envelope(
          { status: "not_converged", visualization: { views: [{ path: "x.png" }] } },
          { fluidDomain: "f".repeat(64), spec: "s".repeat(64) },
        ) as never;
      },
    });
    const result = await runSimulationLifecycle({
      cwd,
      adapter: simulateAdapter("stub-fallback"),
      spec: {},
      subject: { fallbackInputKeys: ["artifact", "fluidDomain"] },
    });
    assert.equal(result.artifactHash, "f".repeat(64), "fluidDomain fallback");
    assert.equal(result.solved, false);
    assert.deepEqual(result.images, [], "no images unless solved");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
