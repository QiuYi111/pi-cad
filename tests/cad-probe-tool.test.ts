/**
 * Unified cad_probe tool tests (refactor Phase 3).
 *
 * Covers: preset dispatch through the probe registry, subject resolution
 * from run state, python mode fencing, and the immutability contract
 * (probing never touches state).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";

import { CadProbeParametersSchema } from "../src/modules/probe/tool.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("cad_probe schema is preset-discriminated and fail-closed", () => {
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: "current" }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: { kind: "artifact", path: "build/part.step", sha256: "a".repeat(64) } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: { kind: "artifact", path: "build/part.step" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: { kind: "artifact", path: "build/part.step", sha256: "wrong" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: { kind: "artifact", path: "build/part.step", sha256: "a".repeat(64) }, purpose: "count", code: "result = 1" }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", args: { artifact: "part.step" } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry" }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "geometry", subject: "current", args: { artifact: "part.step" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "visual", subject: "current", args: { views: ["iso_opposite"], display: "hidden_edges", focus: ["arm"], explode: 0.5 } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "visual", subject: "current", args: { display: "nonsense" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "compare", args: { before: "a.step", after: "b.step" } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "compare", args: { artifact: "a.step" } }), false);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: "current", purpose: "count", code: "result = 1" }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: "current", purpose: "count", code: "result = 1", args: { enabled: false, title: "孔组", list: [1, null] } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: "current", purpose: "count", script: "checks/probe.py", args: { enabled: false } }), true);
  assert.equal(Value.Check(CadProbeParametersSchema, { preset: "python", subject: "current", purpose: "count", script: "checks/probe.py", code: "result = 1" }), false);
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

  // A v7 harness run with the design bound as its authoritative artifact, so
  // subject resolution reads the run state (no v6 project pointer).
  const workflow = compileWorkflowDefinition({ schema: 1, id: "test/cad-probe", version: "1.0.0", parametersSchema: {}, initialPhase: "review", phases: {
    review: { purpose: "Observe", actions: ["cad_probe"], grants: ["observe"], writeScopes: ["run:observation"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action", "mechanical.observations"], hooks: [], transitions: { done: { target: "end" } } },
    end: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
  } }, mechanicalRegistries);
  const loaded = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
  const runId = loaded.state.runId;
  const fixture = readFileSync(new URL("./fixtures/interference_contact.step", import.meta.url));
  mkdirSync(join(cwd, "build"), { recursive: true });
  writeFileSync(join(cwd, "build", "part.step"), fixture);
  const runStore = new HarnessRunStoreV7(cwd, runId);
  await runStore.mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, artifacts: { authoritative: { id: "authoritative", path: "build/part.step", sha256: createHash("sha256").update(fixture).digest("hex"), role: "authoritative" } }, updatedAt: new Date().toISOString() },
    event: { type: "ArtifactBound", data: { path: "build/part.step" } },
    payloads: {},
  }));
  // Probing records observations, so compare the decision-relevant state only.
  const runStateSnapshot = async () => {
    const state = await runStore.transactions.readJson<any>("state.json");
    return JSON.stringify({ phase: state.phase, artifacts: state.artifacts, evidence: state.evidence, staleEvidence: state.staleEvidence });
  };
  const stateBefore = await runStateSnapshot();

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
    assert.equal(await runStateSnapshot(), stateBefore, "state must be unchanged");
  });

  await test("cad_probe: reusable project script receives decoded JSON parameters", async () => {
    mkdirSync(join(cwd, "checks"), { recursive: true });
    writeFileSync(join(cwd, "checks", "named.py"), "result = {'label': params['label'], 'enabled': params['enabled'], 'values': params['values']}\n");
    const args = { label: "孔\"组", enabled: false, values: [1, null, true] };
    const result = await probe.execute(
      "t4b",
      { preset: "python", subject: "current", purpose: "script parameters", script: "checks/named.py", args },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(result.details.envelope.ok, JSON.stringify(result.details.envelope.payload));
    assert.deepEqual(result.details.envelope.payload.result, args);
    assert.ok(result.details.envelope.inputHashes.parameters);
  });

  await test("cad_probe: cancellation stops the hosted Python process", async () => {
    const controller = new AbortController();
    const pending = probe.execute(
      "t4c",
      { preset: "python", subject: "current", purpose: "cancel", code: "while True:\n    pass" },
      controller.signal,
      undefined,
      { cwd },
    );
    setTimeout(() => controller.abort(), 250).unref();
    await assert.rejects(pending, /abort|termination|failed/i);
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
