import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { adaptSimulationV2Recipe } from "../src/domains/mechanical/recipe-adapters/simulation-v2.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { loadSimulationRecipe } from "../src/modules/simulate-v2/protocol.ts";

test("pi-sim.toml adapter produces a strict unified Recipe without changing Simulation V2 identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-recipe-adapter-"));
  try {
    await mkdir(join(cwd, "simulation", "case"), { recursive: true });
    await mkdir(join(cwd, "inputs"));
    await writeFile(join(cwd, "inputs", "domain.step"), "domain");
    await writeFile(join(cwd, "simulation", "case", "Allrun"), "#!/bin/bash\ntrue\n");
    await writeFile(join(cwd, "simulation", "case", "observe.py"), "print('observe')\n");
    await writeFile(join(cwd, "simulation", "case", "pi-sim.toml"), `schema = 1
entrypoint = "./Allrun"
observe = "uv run --offline --frozen --project $PI_CAD_PYTHON_PROJECT python observe.py"
nonvisual = true
inputs = ["../../inputs/domain.step"]
observation_files = ["observe.py"]

[exports.metric]
type = "scalar"
primary = true
unit = "1"
`);
    const loaded = await loadSimulationRecipe(cwd, "simulation/case");
    const first = await adaptSimulationV2Recipe({ recipe: loaded, backend: "torch-fem", runtime: "torch-fem-0.9-cpu", registries: mechanicalRegistries });
    const second = await adaptSimulationV2Recipe({ recipe: loaded, backend: "torch-fem", runtime: "torch-fem-0.9-cpu", registries: mechanicalRegistries });
    assert.deepEqual(second, first);
    assert.equal(first.kind, "simulation");
    assert.deepEqual(first.actions.run!.argv, ["/bin/bash", "-lc", "./Allrun"]);
    assert.ok(first.actions.run!.files.includes("Allrun"));
    assert.ok(!first.actions.run!.files.includes("observe.py"));
    assert.ok(first.observer.files.includes("observe.py"));
    assert.equal(first.inputs[0]!.path, "inputs/domain.step");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
