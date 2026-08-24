import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SimulationPreflightError, preflightSimulation } from "../src/modules/simulate-v2/preflight.ts";
import { recordSimulationFailure, simulationFailure } from "../src/modules/simulate-v2/failure.ts";

const state = {
  phase: "review",
  mutationPolicy: "read_only",
  route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" },
} as any;

const unavailableRunner = {
  async resolveRuntime() { throw new Error("managed runtime probe unavailable"); },
  async execute() { throw new Error("compute must not start during preflight"); },
};

test("simulation preflight aggregates Recipe/input/observer/runtime issues before compute", async () => {
  const cwd = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "pi-cad-preflight-")));
  try {
    const recipe = join(cwd, "simulation", "broken");
    await mkdir(recipe, { recursive: true });
    await writeFile(join(recipe, "pi-sim.toml"), `schema = 1
entrypoint = "./Allrun"
observe = "uv run --offline --frozen --project $PI_CAD_PYTHON_PROJECT python observe.py"
nonvisual = false
inputs = ["../../missing.step"]
observation_files = ["observe.py"]

[exports.view]
type = "image"
primary = true

[exports.metric]
type = "scalar"
primary = true
`, "utf-8");
    await assert.rejects(
      preflightSimulation({ cwd, state, backend: "openfoam", runtime: "openfoam-14", recipePath: "simulation/broken", runner: unavailableRunner }),
      (error: unknown) => {
        assert.ok(error instanceof SimulationPreflightError);
        const codes = error.failure.issues?.map((item) => item.code) ?? [];
        assert.ok(codes.includes("input_missing"));
        assert.ok(codes.includes("observation_missing"));
        assert.ok(codes.includes("entrypoint_missing"));
        assert.ok(codes.includes("observer_missing"));
        assert.ok(codes.includes("runtime_unavailable"));
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("simulation preflight rejects passing pi-sim.toml instead of its directory", async () => {
  const cwd = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "pi-cad-preflight-path-")));
  try {
    await mkdir(join(cwd, "simulation"), { recursive: true });
    await writeFile(join(cwd, "simulation", "pi-sim.toml"), "schema = 1\n", "utf-8");
    await assert.rejects(
      preflightSimulation({ cwd, state, backend: "x", runtime: "x", recipePath: "simulation/pi-sim.toml", runner: unavailableRunner }),
      (error: unknown) => error instanceof SimulationPreflightError && Boolean(error.failure.issues?.some((item) => item.code === "recipe_manifest_passed")),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stable simulation failure records repeat count and changed-state retry requirements", async () => {
  const cwd = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "pi-cad-failure-")));
  try {
    const failure = simulationFailure({ stage: "runtime", code: "runtime_unavailable", retryable: true, likelyOwner: "runtime", suggestedAction: "repair runtime", message: "CUDA unavailable" });
    const first = await recordSimulationFailure(cwd, "r1", failure);
    const second = await recordSimulationFailure(cwd, "r1", failure);
    assert.equal(first.previousOccurrences, 0);
    assert.equal(second.previousOccurrences, 1);
    assert.ok(second.retryRequires?.some((item) => item.includes("driver")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
