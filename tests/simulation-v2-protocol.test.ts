import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderSimulationObservation, validateObservationFile } from "../src/modules/simulate-v2/observation.ts";
import { loadSimulationRecipe, parseSimulationManifest, selectSimulationOutputs } from "../src/modules/simulate-v2/protocol.ts";

const manifest = (extra = "") => `schema = 1
entrypoint = "./Allrun"
observe = "uv run --project ../../python python observe.py"
nonvisual = false
inputs = ["../../build/domain.step"]
observation_files = ["observe.py", "postprocess/"]
${extra}
[exports.phase_distribution]
type = "image"
primary = true

[exports.fill_fraction]
type = "scalar"
primary = true
unit = "1"

[exports.history]
type = "timeseries"
primary = false
`;

test("Simulation V2 manifest is strict and output selection preserves the primary floor", () => {
  const parsed = parseSimulationManifest(manifest());
  assert.deepEqual(selectSimulationOutputs(parsed), ["phase_distribution", "fill_fraction"]);
  assert.deepEqual(selectSimulationOutputs(parsed, ["history"]), ["phase_distribution", "fill_fraction", "history"]);
  assert.throws(() => selectSimulationOutputs(parsed, []), /outputs=\[\] is invalid/);
  assert.throws(() => selectSimulationOutputs(parsed, ["missing"]), /unknown recipe output/);
  assert.throws(() => parseSimulationManifest(manifest("physics = \"forbidden\"\n")), /unknown manifest key/);
  assert.throws(() => parseSimulationManifest(manifest().replace("primary = true", "primary = false")), /primary image/);
});

test("compute and observation identities split post-processing from compute", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-v2-hash-"));
  try {
    await mkdir(join(cwd, "simulation", "case", "postprocess"), { recursive: true });
    await mkdir(join(cwd, "build"), { recursive: true });
    await writeFile(join(cwd, "build", "domain.step"), "domain-v1");
    await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), manifest());
    await writeFile(join(cwd, "simulation", "case", "Allrun"), "solver settings v1");
    await writeFile(join(cwd, "simulation", "case", "observe.py"), "observe v1");
    await writeFile(join(cwd, "simulation", "case", "postprocess", "plot.py"), "plot v1");
    const first = await loadSimulationRecipe(cwd, "simulation/case");
    await writeFile(join(cwd, "simulation", "case", "observe.py"), "observe v2");
    const observed = await loadSimulationRecipe(cwd, "simulation/case");
    assert.equal(observed.computeRecipeHash, first.computeRecipeHash);
    assert.notEqual(observed.observationProgramHash, first.observationProgramHash);
    await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), manifest().replace("nonvisual = false", "nonvisual = true").replace('[exports.phase_distribution]\ntype = "image"\nprimary = true\n\n', ""));
    const nonvisual = await loadSimulationRecipe(cwd, "simulation/case");
    assert.equal(nonvisual.computeRecipeHash, first.computeRecipeHash, "nonvisual is an observation-context declaration");
    assert.notEqual(nonvisual.observationProgramHash, first.observationProgramHash);
    await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), manifest());
    await writeFile(join(cwd, "simulation", "case", "Allrun"), "solver settings v2");
    const recompute = await loadSimulationRecipe(cwd, "simulation/case");
    assert.notEqual(recompute.computeRecipeHash, first.computeRecipeHash);
    await writeFile(join(cwd, "build", "domain.step"), "domain-v2");
    const inputChanged = await loadSimulationRecipe(cwd, "simulation/case");
    assert.notEqual(inputChanged.inputs[0].sha256, first.inputs[0].sha256);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recipe and declared-input paths fail closed on escape and symlink escape", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-v2-path-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-cad-sim-v2-outside-"));
  try {
    await mkdir(join(cwd, "simulation", "case", "postprocess"), { recursive: true });
    await mkdir(join(cwd, "build"), { recursive: true });
    await writeFile(join(cwd, "build", "domain.step"), "domain");
    await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), manifest());
    await writeFile(join(cwd, "simulation", "case", "Allrun"), "solver");
    await writeFile(join(cwd, "simulation", "case", "observe.py"), "observer");
    await mkdir(join(outside, "secret"));
    await writeFile(join(outside, "secret", "value"), "secret");
    await symlink(join(outside, "secret"), join(cwd, "simulation", "case", "leak"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(loadSimulationRecipe(cwd, "simulation/case"), /symlink escapes/);
    const escaped = manifest().replace('../../build/domain.step', '../../../outside.step');
    await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), escaped);
    await assert.rejects(loadSimulationRecipe(cwd, "simulation/case"), /declared input escapes/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Observation validates all quantitative shapes and generates a PNG timeseries plot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-v2-observe-"));
  try {
    const parsed = parseSimulationManifest(manifest().replace("nonvisual = false", "nonvisual = true").replace('[exports.phase_distribution]\ntype = "image"\nprimary = true\n\n', ""));
    await writeFile(join(cwd, "series.json"), JSON.stringify({ x: [0, 1, 2], y: [2, 4, 3] }));
    const observationFile = join(cwd, "observation.json");
    await writeFile(observationFile, JSON.stringify({ schema: 1, exports: { fill_fraction: { type: "scalar", value: 0.5, unit: "1" }, history: { type: "timeseries", path: "series.json" } } }));
    const result = await validateObservationFile({ manifest: parsed, observationFile, workspace: cwd, selectedNames: ["fill_fraction", "history"], plotDir: join(cwd, "plots"), computeSucceeded: true });
    assert.equal(result.validForCommit, true);
    const series = result.selected.find((item) => item.name === "history")!;
    assert.match(series.summary!, /3 samples/);
    assert.deepEqual([...((await readFile(series.plotPath!)).subarray(0, 8))], [137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(observationFile, JSON.stringify({ schema: 1, exports: { fill_fraction: { type: "scalar", value: Number.NaN } } }));
    await assert.rejects(validateObservationFile({ manifest: parsed, observationFile, workspace: cwd, selectedNames: ["fill_fraction"], plotDir: join(cwd, "plots2"), computeSucceeded: true }), /finite/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Observation materializes image, scalar, timeseries, table, field, and artifact strictly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-v2-all-exports-"));
  try {
    const parsed = parseSimulationManifest(`${manifest()}
[exports.rows]
type = "table"
primary = false

[exports.native_field]
type = "field"
primary = false
format = "openfoam"

[exports.report]
type = "artifact"
primary = false
format = "json"
`);
    await writeFile(join(cwd, "phase.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    await writeFile(join(cwd, "series.json"), JSON.stringify({ x: [0, 1], y: [1, 2] }));
    await writeFile(join(cwd, "table.json"), JSON.stringify({ columns: ["case", "value"], rows: [["a", 1]] }));
    await writeFile(join(cwd, "field.foam"), "field");
    await writeFile(join(cwd, "report.json"), "{}");
    const observationFile = join(cwd, "observation.json");
    await writeFile(observationFile, JSON.stringify({ schema: 1, exports: {
      phase_distribution: { type: "image", path: "phase.png" },
      fill_fraction: { type: "scalar", value: 0.5, unit: "1" },
      history: { type: "timeseries", path: "series.json" },
      rows: { type: "table", path: "table.json" },
      native_field: { type: "field", path: "field.foam", format: "openfoam" },
      report: { type: "artifact", path: "report.json", format: "json" },
    } }));
    const result = await validateObservationFile({ manifest: parsed, observationFile, workspace: cwd, selectedNames: Object.keys(parsed.exports), plotDir: join(cwd, "plots"), computeSucceeded: true });
    assert.equal(result.validForCommit, true);
    assert.deepEqual(new Set(result.selected.map((item) => item.declaration.type)), new Set(["image", "scalar", "timeseries", "table", "field", "artifact"]));
    const content = await renderSimulationObservation({
      runId: "sim-001", observationId: "obs-001", backend: "torch-fem", runtime: "torch-fem-0.9-cu126", durationMs: 1000,
      runtimeIdentity: { resolvedVersion: "torch-fem=0.9.0", digest: "d".repeat(64), accelerator: { requestedDevice: "cuda", actualDevice: "cuda", gpu: "TITAN Xp", cupy: "14.1.1" } },
      observation: result,
    });
    assert.equal(content[0].type, "image", "primary image must be first");
    assert.match(content[1].text!, /Quantitative scalars[\s\S]*fill_fraction/);
    assert.equal(content[2].type, "image", "timeseries plot follows scalar context");
    assert.match(content[3].text!, /Timeseries[\s\S]*history[\s\S]*Tables[\s\S]*row: a \| 1[\s\S]*Solver health[\s\S]*actual device: cuda[\s\S]*GPU: TITAN Xp[\s\S]*Diagnostics[\s\S]*Artifacts/);
    await writeFile(join(cwd, "table.json"), JSON.stringify({ columns: ["a"], rows: [[1, 2]] }));
    await assert.rejects(validateObservationFile({ manifest: parsed, observationFile, workspace: cwd, selectedNames: ["rows"], plotDir: join(cwd, "plots2"), computeSucceeded: true }), /row width mismatch/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
