import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyAnalysisModel } from "../src/extensions/simulation/analysis-model.ts";
import { CadProjectStore } from "../src/shared/store.ts";

async function workspaceWithCanonical(): Promise<{
  cwd: string;
  canonical: string;
  derived: string;
}> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-analysis-model-"));
  mkdirSync(join(cwd, ".pi-cad"), { recursive: true });
  const canonical = join(cwd, "design.step");
  const derived = join(cwd, "design-fused.step");
  writeFileSync(canonical, "canonical design bytes");
  writeFileSync(derived, "fused single-solid bytes");
  const store = new CadProjectStore(cwd);
  const project = await store.ensureProject();
  const { createHash } = await import("node:crypto");
  await store.updateHead({
    artifactPath: "design.step",
    artifactHash: createHash("sha256").update("canonical design bytes").digest("hex"),
    evidence: project.head.evidence,
  });
  return { cwd, canonical, derived };
}

test("analysis model: derived subject without declaration fails closed", async () => {
  const { cwd, derived } = await workspaceWithCanonical();
  try {
    const check = await verifyAnalysisModel(cwd, { subject: derived });
    assert.ok(check.error);
    assert.match(check.error, /analysisModel/);
    assert.equal(check.subjectOverrideHash, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: canonical subject needs no declaration", async () => {
  const { cwd, canonical } = await workspaceWithCanonical();
  try {
    const check = await verifyAnalysisModel(cwd, { subject: canonical });
    assert.equal(check.error, undefined);
    assert.equal(check.subjectOverrideHash, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: declared derivation binds evidence to the source", async () => {
  const { cwd, canonical, derived } = await workspaceWithCanonical();
  try {
    const check = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { source: canonical, operations: ["fused"] },
    });
    assert.equal(check.error, undefined);
    const { createHash } = await import("node:crypto");
    assert.equal(
      check.subjectOverrideHash,
      createHash("sha256").update("canonical design bytes").digest("hex"),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: fake provenance (source not canonical) fails closed", async () => {
  const { cwd, derived } = await workspaceWithCanonical();
  try {
    const stranger = join(cwd, "stranger.step");
    writeFileSync(stranger, "not the canonical design");
    const check = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { source: stranger, operations: ["simplified"] },
    });
    assert.ok(check.error);
    assert.match(check.error, /not a canonical design/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: no design context (adhoc) is unprotected by design", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-adhoc-"));
  try {
    const loose = join(cwd, "anything.step");
    writeFileSync(loose, "bytes");
    const check = await verifyAnalysisModel(cwd, { subject: loose });
    assert.equal(check.error, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: current run candidate counts as canonical too", async () => {
  const { cwd } = await workspaceWithCanonical();
  try {
    const candidate = join(cwd, "candidate.step");
    writeFileSync(candidate, "current candidate bytes");
    const { createHash } = await import("node:crypto");
    const store = new CadProjectStore(cwd);
    const run = await store.createRun({ runId: "am-run" });
    const { createIntakeState } = await import("../src/core/state-machine.ts");
    const state = createIntakeState({ runId: "am-run", projectId: store.projectId });
    await run.save({
      ...state,
      currentArtifactPath: "candidate.step",
      currentArtifactHash: createHash("sha256").update("current candidate bytes").digest("hex"),
    });
    const check = await verifyAnalysisModel(cwd, { subject: candidate });
    assert.equal(check.error, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
