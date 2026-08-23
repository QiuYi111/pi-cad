/**
 * Observation index tests (refactor Phase 8: Context Runtime v2).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  queryObservations,
  rehydrateVisuals,
  recordObservation,
  renderObservationIndex,
  type ObservationRecord,
} from "../src/core/observation-index.ts";
import type { ObservationBundle } from "../src/observations/bundle.ts";

function bundle(overrides: Partial<ObservationBundle> = {}): ObservationBundle {
  return {
    ok: true,
    tool: "cad_inspect_geometry",
    headline: "geometry facts: part.step",
    visuals: [],
    facts: [{ key: "volume", value: "1000.000" }],
    diagnostics: [],
    provenance: {
      tool: "cad_inspect_geometry",
      durationMs: 5,
      inputHashes: {},
      outputHashes: {},
    },
    artifacts: [],
    ...overrides,
  };
}

const cwd = mkdtempSync(join(tmpdir(), "pi-cad-obsidx-"));
const runId = "r1";
try {
  test("index: append, query filters, visual rehydration", async () => {
    await recordObservation({
      cwd, runId, phase: "build", tool: "cad_build_step",
      bundle: bundle({ tool: "cad_build_step", headline: "build ok" }),
      artifactHash: "a".repeat(64),
    });
    await recordObservation({
      cwd, runId, phase: "review", tool: "cad_probe",
      bundle: bundle({
        tool: "cad_inspect_visual",
        headline: "visual render: 7 views",
        visuals: [{ name: "iso", path: "evidence/iso.png" }],
        artifacts: [{ path: "evidence/iso.png", kind: "image", sha256: "c".repeat(64) }],
      }),
      artifactHash: "b".repeat(64),
      evidenceKind: "visual",
    });
    await recordObservation({
      cwd, runId, phase: "review", tool: "cad_probe",
      bundle: bundle({ ok: false, headline: "section failed" }),
    });

    const all = await queryObservations(cwd, runId, { limit: 10 });
    assert.equal(all.length, 3);
    assert.equal(all[0].headline, "section failed", "newest first");

    const visualsOnly = await queryObservations(cwd, runId, { withVisualsOnly: true });
    assert.equal(visualsOnly.length, 1);
    assert.equal(visualsOnly[0].evidenceKind, "visual");
    assert.equal(visualsOnly[0].visuals[0]?.sha256, "c".repeat(64));

    const byArtifact = await queryObservations(cwd, runId, { artifactHash: "a".repeat(64) });
    assert.equal(byArtifact.length, 1);
    assert.equal(byArtifact[0].tool, "cad_build_step");

    const hydrated = await rehydrateVisuals(cwd, runId, {});
    assert.equal(hydrated.length, 1);
    assert.deepEqual(hydrated[0].paths, ["evidence/iso.png"]);
  });

  test("index: renderObservationIndex lists ok observations with recall hint", async () => {
    const text = await renderObservationIndex(cwd, runId);
    assert.ok(text.includes("## Recent Observations"));
    assert.ok(text.includes("cad_recall_observation"));
    assert.ok(!text.includes("section failed"), "failed observations stay out of the prompt index");
  });

  test("index: quota trims the head beyond the cap", async () => {
    // Write a bulk index directly to exercise trimming without 400 awaits.
    const dir = join(cwd, ".pi-cad", "runs", runId, "context");
    mkdirSync(dir, { recursive: true });
    const bulk: ObservationRecord[] = Array.from({ length: 405 }, (_, i) => ({
      id: i + 1,
      ts: `2026-01-01T00:00:00Z`,
      phase: "build",
      tool: "cad_probe",
      backendTool: "cad_inspect_geometry",
      ok: true,
      headline: `obs ${i + 1}`,
      facts: [],
      visuals: [],
    }));
    writeFileSync(
      join(dir, "observations.jsonl"),
      bulk.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await recordObservation({
      cwd, runId, phase: "build", tool: "cad_probe", bundle: bundle(),
    });
    const lines = readFileSync(join(dir, "observations.jsonl"), "utf8").trim().split("\n");
    assert.ok(lines.length <= 301, `index bounded: ${lines.length}`);
    const first = JSON.parse(lines[0]) as ObservationRecord;
    assert.ok(first.id >= 405 - 300, "head trimmed, newest retained");
  });

  await test("cad_recall_observation: re-attaches recorded visuals", async () => {
    const { default: ext } = await import("../src/extensions/probe/index.ts");
    const { CadProjectStore } = await import("../src/shared/store.ts");
    const store = new CadProjectStore(cwd);
    // Project + state so the tool resolves the active run.
    mkdirSync(join(cwd, ".pi-cad", "runs", runId), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-cad", "project.json"),
      JSON.stringify({
        schemaVersion: 5, projectId: "p", head: {}, currentRunId: runId,
        createdAt: "x", updatedAt: "x",
      }),
    );
    writeFileSync(
      join(cwd, ".pi-cad", "runs", runId, "state.json"),
      JSON.stringify({
        schemaVersion: 5, runId, projectId: "p", createdAt: "x", updatedAt: "x",
        route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" },
        phase: "review", status: "active", mutationPolicy: "read_only",
        evidence: [], staleEvidence: [],
      }),
    );
    void store;

    const tools = new Map();
    const pi = { registerTool: (t: any) => tools.set(t.name, t), registerCommand: () => {}, on: () => {} };
    ext(pi);
    const recall = tools.get("cad_recall_observation");
    assert.ok(recall, "cad_recall_observation registered");

    // Fresh image on disk so recall can attach it.
    const png = join(cwd, "evidence", "iso.png");
    mkdirSync(join(cwd, "evidence"), { recursive: true });
    writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    await recordObservation({
      cwd, runId, phase: "review", tool: "cad_probe",
      bundle: bundle({
        visuals: [{ name: "iso", path: png }],
        headline: "visual render with real image",
      }),
      evidenceKind: "visual",
    });

    const result = await recall.execute(
      "t1",
      { evidenceKind: "visual", limit: 3 },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0].text as string;
    assert.match(text, /visual render with real image/);
    const images = result.content.filter((c: { type: string }) => c.type === "image");
    assert.equal(images.length, 1);
    assert.ok(existsSync(png));
  });
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
