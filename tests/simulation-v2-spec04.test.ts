import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSimulationRecipe } from "../src/modules/simulate-v2/protocol.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RECIPE = join(ROOT, "benchmarks", "simulation-v2", "spec04-template");

test("SPEC-04 ships a repository-owned OpenFOAM case and keeps only authoritative inputs external", async () => {
  const recipe = await loadSimulationRecipe(ROOT, "benchmarks/simulation-v2/spec04-template");
  assert.equal(recipe.manifest.entrypoint, "bash Allrun");
  assert.deepEqual(recipe.manifest.inputs, [".ignored-benchmark-inputs/"]);
  const orchestrator = await readFile(join(RECIPE, "orchestrate.py"), "utf-8");
  assert.match(orchestrator, /case_driver\.py/);
  assert.doesNotMatch(orchestrator, /project-case|Allrun\.spec04/);
  for (const path of [
    "case_driver.py",
    "aggregate_results.py",
    "openfoam-case/system/fvSchemes",
    "openfoam-case/system/fvSolution",
    "openfoam-case/system/meshQualityDict",
    "openfoam-case/constant/momentumTransport",
  ]) assert.equal((await stat(join(RECIPE, path))).isFile(), true, `missing bundled SPEC-04 component ${path}`);
  for (const name of ["materials", "surface-mapping", "release-criteria"]) {
    const schema = JSON.parse(await readFile(join(RECIPE, "input-schemas", `${name}.schema.json`), "utf-8"));
    assert.equal(schema.additionalProperties, false);
  }
});

test("SPEC-04 release observer applies Rev1 limits and cannot PASS blocked inputs", async () => {
  const observer = await readFile(join(RECIPE, "observe.py"), "utf-8");
  assert.match(observer, /maxPostPlugTrappedGas/);
  assert.match(observer, /maxPeakPressure/);
  assert.match(observer, /maxPeakForce/);
  assert.match(observer, /maxPoseError/);
  assert.match(observer, /maxMassError/);
  assert.match(observer, /status\.get\("status"\) != "computed"/);
  assert.match(observer, /releaseVerdict.*None/);
});
