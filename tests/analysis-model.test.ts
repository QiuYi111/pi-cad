import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyAnalysisModel } from "../src/extensions/simulation/analysis-model.ts";
import { CadProjectStore } from "../src/shared/store.ts";
import { createHash } from "node:crypto";

const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

async function workspaceWithCanonical(): Promise<{
  cwd: string;
  canonical: string;
  derived: string;
  stranger: string;
}> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-analysis-model-"));
  mkdirSync(join(cwd, ".pi-cad"), { recursive: true });
  const canonical = join(cwd, "design.step");
  const derived = join(cwd, "design-fused.step");
  const stranger = join(cwd, "unrelated.step");
  writeFileSync(canonical, "canonical design bytes");
  writeFileSync(derived, "fused single-solid bytes");
  writeFileSync(stranger, "a completely unrelated model");
  const store = new CadProjectStore(cwd);
  const project = await store.ensureProject();
  await store.updateHead({
    artifactPath: "design.step",
    artifactHash: hashOf("canonical design bytes"),
    evidence: project.head.evidence,
  });
  return { cwd, canonical, derived, stranger };
}

function recordFor(cwd: string, sourceHash: string, outputHash: string, name = "derivation.json"): string {
  const path = join(cwd, name);
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 1, sourceHash, outputHash, operations: ["fused"], executed: true }),
  );
  return path;
}

test("analysis model: derived subject without declaration fails closed", async () => {
  const { cwd, derived } = await workspaceWithCanonical();
  try {
    const check = await verifyAnalysisModel(cwd, { subject: derived });
    assert.ok(check.error);
    assert.match(check.error, /analysisModel/);
    assert.match(check.error, /cad_derive_analysis_model/);
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

test("analysis model: valid derivation binds evidence to the source", async () => {
  const { cwd, canonical, derived } = await workspaceWithCanonical();
  try {
    const ref = recordFor(cwd, hashOf("canonical design bytes"), hashOf("fused single-solid bytes"));
    const check = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { derivationRef: ref },
    });
    assert.equal(check.error, undefined);
    assert.equal(check.subjectOverrideHash, hashOf("canonical design bytes"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: the record's output must match the geometry actually solved (review P0-6)", async () => {
  const { cwd, stranger } = await workspaceWithCanonical();
  try {
    // An unrelated STEP cannot borrow provenance: the record was made for a
    // DIFFERENT output, so the subject/record mismatch fails closed even
    // though the record's source is canonical.
    const ref = recordFor(cwd, hashOf("canonical design bytes"), hashOf("fused single-solid bytes"));
    const check = await verifyAnalysisModel(cwd, {
      subject: stranger,
      analysisModel: { derivationRef: ref },
    });
    assert.ok(check.error);
    assert.match(check.error, /not the model the derivation record produced/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: fake provenance (non-canonical source) fails closed", async () => {
  const { cwd, derived } = await workspaceWithCanonical();
  try {
    const ref = recordFor(cwd, hashOf("not the canonical design"), hashOf("fused single-solid bytes"));
    const check = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { derivationRef: ref },
    });
    assert.ok(check.error);
    assert.match(check.error, /not a canonical design/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("analysis model: malformed and missing records fail closed", async () => {
  const { cwd, derived } = await workspaceWithCanonical();
  try {
    const missing = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { derivationRef: join(cwd, "nope.json") },
    });
    assert.ok(missing.error);
    assert.match(missing.error as string, /does not exist/);

    const malformed = join(cwd, "bad.json");
    writeFileSync(malformed, "{not json");
    const bad = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { derivationRef: malformed },
    });
    assert.ok(bad.error);
    assert.match(bad.error as string, /malformed|readable/);

    const incomplete = join(cwd, "incomplete.json");
    writeFileSync(incomplete, JSON.stringify({ sourceHash: hashOf("canonical design bytes") }));
    const partial = await verifyAnalysisModel(cwd, {
      subject: derived,
      analysisModel: { derivationRef: incomplete },
    });
    assert.ok(partial.error);
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
