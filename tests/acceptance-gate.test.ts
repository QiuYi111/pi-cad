/**
 * Acceptance gate tests (three layers).
 *
 * T1/T2 are deterministic and always on. T3 (adversarial reviewer) is
 * env-gated and stubbed here with a fake model registry.
 *
 * The canonical scenario is benchmark sample 00006892: Must says width
 * 0.52105, measured bbox says 0.260525 — the agent rationalized it
 * through. The gate must block exactly that.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildEvidenceDigest,
  reconcileClaim,
  runAcceptanceGate,
  type AcceptanceCheck,
} from "../src/control/acceptance-gate.ts";
import type { CadRunState } from "../src/shared/protocol.ts";

function geometryEnvelopePath(dir: string, bbox: [number, number, number], cylinders: number): string {
  const path = join(dir, "geometry.json");
  writeFileSync(
    path,
    JSON.stringify({
      ok: true,
      tool: "cad_inspect_geometry",
      payload: {
        bbox: { x: bbox[0], y: bbox[1], z: bbox[2] },
        volume: 0.061701,
        surfaceArea: 1.338,
        solidCount: 1,
        cylinders: Array.from({ length: cylinders }, () => ({ radius: 0.85 })),
        planes: [],
        units: "mm",
      },
    }),
  );
  return path;
}

function stateWith(overrides: Partial<CadRunState> = {}): CadRunState {
  return {
    schemaVersion: 4,
    runId: "r-gate",
    projectId: "p",
    createdAt: "x",
    updatedAt: "x",
    phase: "review",
    status: "active",
    mutationPolicy: "read_only",
    evidence: [],
    staleEvidence: [],
    currentArtifactPath: "build/part.step",
    currentArtifactHash: "a".repeat(64),
    ...overrides,
  } as CadRunState;
}

function projectWithMust(cwd: string, must: string[], runId = "r-gate"): void {
  mkdirSync(join(cwd, ".pi-cad", "runs", runId, "records"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi-cad", "runs", runId, "records", "requirements.json"),
    JSON.stringify({
      goal: "g",
      must,
      deliverables: [],
      preferences: [],
      assumptions: [],
      openUnknowns: [],
    }),
  );
}

test("digest: geometry evidence reduces to the number set", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    const path = geometryEnvelopePath(cwd, [1.5, 0.260525, 0.15789], 0);
    const digest = await buildEvidenceDigest(cwd, stateWith({
      evidence: [
        { id: "e1", kind: "geometry", artifactHash: "a".repeat(64), paths: [path] },
      ] as never,
    }));
    assert.ok(digest);
    assert.equal(digest.numbers["bbox.y"], 0.260525);
    assert.equal(digest.numbers.cylinderCount, 0);
    assert.equal(digest.numbers.solidCount, 1);
    assert.ok(digest.lines[0].includes("cylinders=0"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reconcile: the 00006892 rationalization is caught deterministically", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    const path = geometryEnvelopePath(cwd, [1.5, 0.260525, 0.15789], 0);
    const digest = (await buildEvidenceDigest(cwd, stateWith({
      evidence: [{ id: "e1", kind: "geometry", artifactHash: "a".repeat(64), paths: [path] }] as never,
    })))!;
    // Agent claims the spec width while the part measures half of it.
    const contradiction = reconcileClaim({ mustRef: "Prism width is 0.52105 units", claimedValue: 0.52105 }, digest);
    assert.ok(contradiction, "0.52105 must NOT reconcile against the 0.260525 part");
    assert.ok(contradiction.digest.includes("bbox.y=0.260525"));
    // A truthful claim reconciles.
    assert.equal(reconcileClaim({ mustRef: "width", claimedValue: 0.2605 }, digest), null);
    // Exact counts reconcile only against themselves.
    assert.equal(reconcileClaim({ mustRef: "solids", claimedValue: 1 }, digest), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate T2: fewer checks than Must items blocks; matching truthful checks pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    projectWithMust(cwd, ["Prism width is 0.52105 units", "Prism length is 1.5 units"]);
    const path = geometryEnvelopePath(cwd, [1.5, 0.260525, 0.15789], 0);
    const state = stateWith({
      evidence: [{ id: "e1", kind: "geometry", artifactHash: "a".repeat(64), paths: [path] }] as never,
    });

    const short = await runAcceptanceGate({ cwd, state, checks: [], note: "ok" });
    assert.ok(!short.ok);
    assert.match(short.reason!, /0\/2 Mission Must items/);

    const lying = await runAcceptanceGate({
      cwd, state, note: "consistent with stated diameter",
      checks: [
        { mustRef: "Prism width is 0.52105 units", claimedValue: 0.52105, basis: "geometry digest" },
        { mustRef: "Prism length is 1.5 units", claimedValue: 1.5, basis: "geometry digest" },
      ],
    });
    assert.ok(!lying.ok, "the rationalized acceptance must be blocked");
    assert.match(lying.reason!, /claims 0\.52105/);
    assert.match(lying.reason!, /bbox\.y=0\.260525/);

    const truthful = await runAcceptanceGate({
      cwd, state, note: "measured",
      checks: [
        { mustRef: "Prism width is 0.52105 units", claimedValue: 0.260525, basis: "geometry digest bbox.y" },
        { mustRef: "Prism length is 1.5 units", claimedValue: 1.5, basis: "geometry digest bbox.x" },
      ],
    });
    assert.ok(truthful.ok, JSON.stringify(truthful));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate T1: numeric claim with no readable digest fails closed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    projectWithMust(cwd, ["Prism width is 0.52105 units"]);
    const state = stateWith(); // evidence present in state but file missing on disk
    state.evidence = [
      { id: "e1", kind: "geometry", artifactHash: "a".repeat(64), paths: [join(cwd, "missing.json")] },
    ] as never;
    const result = await runAcceptanceGate({
      cwd, state, note: "x",
      checks: [{ mustRef: "Prism width is 0.52105 units", claimedValue: 0.52105, basis: "digest" }],
    });
    assert.ok(!result.ok);
    assert.match(result.reason!, /no readable geometry\/measure evidence/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate T3: stub reviewer — assertions cross-checked, objections block then budget out", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gate-"));
  const prev = { ...process.env };
  process.env.PI_CAD_ACCEPTANCE_REVIEWER = "1";
  process.env.PI_CAD_ACCEPTANCE_MAX_BLOCKS = "1";
  try {
    projectWithMust(cwd, ["Prism width is 0.52105 units", "Semicircular cut through the prism"]);
    const path = geometryEnvelopePath(cwd, [1.5, 0.260525, 0.15789], 0);
    const state = stateWith({
      evidence: [{ id: "e1", kind: "geometry", artifactHash: "a".repeat(64), paths: [path] }] as never,
    });

    const verdict = {
      assertions: [
        { mustRef: "Prism width is 0.52105 units", metric: "width", expected: 0.52105, tolerance: 0.01 },
      ],
      objections: [
        { mustRef: "Semicircular cut through the prism", severity: "blocking", why: "digest shows cylinders=0; a semicircular through-cut must produce a cylindrical face", suggestedProbe: "cad_probe preset=geometry and inspect cylinderCount" },
      ],
    };
    const ctx = {
      model: { id: "stub" },
      modelRegistry: {
        complete: async () => ({
          content: [{ type: "text", text: JSON.stringify(verdict) }],
        }),
      },
    } as never;

    // Truthful agent checks still get blocked by the reviewer's
    // deterministic assertion cross-check (width 0.52105 not in digest).
    const first = await runAcceptanceGate({
      cwd, state, ctx, note: "measured",
      checks: [
        { mustRef: "Prism width is 0.52105 units", claimedValue: 0.260525, basis: "digest bbox.y" },
        { mustRef: "Semicircular cut through the prism", basis: "visual inspection" },
      ],
    });
    assert.ok(!first.ok);
    assert.match(first.reason!, /reviewer: Must "Prism width is 0.52105 units" expects 0\.52105/);
    assert.match(first.reason!, /cylinders=0/);

    // Second call: block budget (1) exhausted → proceeds with dissent.
    const second = await runAcceptanceGate({
      cwd, state, ctx, note: "measured",
      checks: [
        { mustRef: "Prism width is 0.52105 units", claimedValue: 0.260525, basis: "digest bbox.y" },
        { mustRef: "Semicircular cut through the prism", basis: "visual inspection" },
      ],
    });
    assert.ok(second.ok, "budgeted dissent must let the run proceed");
    assert.ok(second.dissent?.length);
  } finally {
    process.env = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate: no Must items → pass-through (legacy flows unaffected)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    projectWithMust(cwd, []);
    const result = await runAcceptanceGate({ cwd, state: stateWith(), note: "x" });
    assert.ok(result.ok);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
