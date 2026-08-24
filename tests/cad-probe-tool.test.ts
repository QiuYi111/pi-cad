/**
 * Unified cad_probe tool tests (refactor Phase 3).
 *
 * Covers: preset dispatch through the probe registry, subject resolution
 * from run state, python mode fencing, and the immutability contract
 * (probing never touches state).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";

import { CadProbeParametersSchema } from "../src/modules/probe/tool.ts";

test("cad_probe schema is preset-discriminated and fail-closed", () => {
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: "current" }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", args: { artifact: "part.step" } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry" }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: "current", args: { artifact: "part.step" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "compare", args: { before: "a.step", after: "b.step" } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "compare", args: { artifact: "a.step" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: "current", purpose: "count", code: "result = 1" }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: "current", purpose: "count", code: "result = 1", args: { artifact: "part.step" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "measure", subject: "current", args: { metric: "distance", a: "#c0", unknown: true } }), false);
});

const cwd = mkdtempSync(join(tmpdir(), "pi-cad-cadprobe-"));
try {
  const { default: ext } = await import("../src/extensions/probe/index.ts");
  const { default: geometryExt } = await import("../src/extensions/geometry/index.ts");
  const tools = new Map();
  const pi = {
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: () => {},
    on: () => {},
  };
  ext(pi);
  geometryExt(pi);
  const probe = tools.get("cad_probe");
  if (!probe) throw new Error("cad_probe not registered");

  // Project + run state so subject resolution works.
  mkdirSync(join(cwd, ".pi-cad", "runs", "r1"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi-cad", "project.json"),
    JSON.stringify({
      schemaVersion: 6, projectId: "p", head: {}, currentRunId: "r1",
      createdAt: "x", updatedAt: "x",
    }),
  );
  const fixture = readFileSync(new URL("./fixtures/interference_contact.step", import.meta.url));
  mkdirSync(join(cwd, "build"), { recursive: true });
  writeFileSync(join(cwd, "build", "part.step"), fixture);
  writeFileSync(
    join(cwd, ".pi-cad", "runs", "r1", "state.json"),
    JSON.stringify({
      schemaVersion: 6, runId: "r1", projectId: "p", createdAt: "x", updatedAt: "x",
      route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" },
      phase: "review", status: "active", mutationPolicy: "read_only",
      evidence: [], staleEvidence: [],
      currentArtifactPath: "build/part.step",
    }),
  );

  const statePath = join(cwd, ".pi-cad", "runs", "r1", "state.json");
  const stateBefore = readFileSync(statePath, "utf8");

  await test("cad_probe: preset geometry resolves subject=current from run state", async () => {
    const result = await probe.execute("t1", { preset: "geometry", subject: "current" }, undefined, undefined, { cwd });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    assert.ok(result.details.envelope.ok, `envelope failed: ${text}`);
    assert.equal(result.details.kind, "geometry");
    assert.ok((result.details.artifactHash as string).length > 0);
    assert.ok(text.includes("facts:"), "observation facts present");
  });

  await test("cad_probe: preset interference renders pair facts", async () => {
    const result = await probe.execute("t2", { preset: "interference", subject: "current" }, undefined, undefined, { cwd });
    assert.ok(result.details.envelope.ok);
    assert.match(
      result.content.find((c) => c.type === "text")?.text ?? "",
      /interference facts: \d+ parts, \d+ pairs/,
    );
  });

  await test("cad_probe: explicit artifact arg overrides subject resolution", async () => {
    const result = await probe.execute(
      "t3",
      { preset: "geometry", args: { artifact: "build/part.step" } },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(result.details.envelope.ok, JSON.stringify(result.details.envelope.payload));
    assert.equal(result.details.kind, "geometry");
  });

  await test("cad_probe: python mode is read-only observation with fencing", async () => {
    const result = await probe.execute(
      "t4",
      {
        preset: "python",
        subject: "current",
        purpose: "solid count",
        code: "result = {'solids': len(shape.solids())}",
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(result.details.envelope.ok, JSON.stringify(result.details.envelope.payload));
    assert.equal(result.details.kind, undefined, "python mode must not bind evidence kind");
    assert.ok(result.details.subjectArtifactHash);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "state must be unchanged");
  });

  await test("cad_probe: python mode rejects baseline without binding", async () => {
    const result = await probe.execute(
      "t5",
      { preset: "python", subject: "baseline", purpose: "x", code: "result = 1" },
      undefined,
      undefined,
      { cwd },
    );
    assert.match(result.content[0].text!, /no baseline artifact bound/);
  });

  await test("cad_probe: unknown artifact and no run state fails closed", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pi-cad-empty-"));
    try {
      const result = await probe.execute(
        "t6",
        { preset: "geometry" },
        undefined,
        undefined,
        { cwd: empty },
      );
      assert.match(result.content[0].text!, /provide exactly one target/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
