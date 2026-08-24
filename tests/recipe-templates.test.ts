import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { compileRecipeDefinition } from "../src/harness/recipe/compiler.ts";
import { parseYamlDocument } from "../src/harness/workflow/loader.ts";

const templates = [
  ["drawing", "../recipes/drawing/cadctl-v1/pi-recipe.yaml", ["generate", "validate"]],
  ["presentation", "../recipes/presentation/cadctl-v1/pi-recipe.yaml", ["generate", "preview", "run", "validate"]],
  ["analysis-model", "../recipes/analysis-model/cadctl-v1/pi-recipe.yaml", ["run"]],
  ["optimization", "../recipes/optimization/torch-fem-v1/pi-recipe.yaml", ["run"]],
  ["simulation", "../benchmarks/simulation-v2/openfoam14-box/pi-recipe.yaml", ["run"]],
  ["simulation", "../benchmarks/simulation-v2/spec04-template/pi-recipe.yaml", ["run"]],
  ["simulation", "../skills/structural-analysis/assets/recipes/torch-fem-linear-elastic/pi-recipe.yaml", ["run"]],
  ["simulation", "../skills/structural-analysis/assets/recipes/torch-fem-differentiable-sensitivity/pi-recipe.yaml", ["run"]],
  ["simulation", "../skills/thermal-fluid-analysis/assets/recipes/openfoam-steady-incompressible/pi-recipe.yaml", ["run"]],
  ["simulation", "../skills/thermal-fluid-analysis/assets/recipes/openfoam-transient-vof/pi-recipe.yaml", ["run"]],
  ["simulation", "../skills/thermal-fluid-analysis/assets/recipes/su2-steady-flow/pi-recipe.yaml", ["run"]],
  ["simulation", "../skills/thermal-fluid-analysis/assets/recipes/su2-solid-thermal/pi-recipe.yaml", ["run"]],
] as const;

test("Mechanical Pack ships strict Recipe templates for every migrated complex capability", async () => {
  for (const [kind, url, actions] of templates) {
    const path = fileURLToPath(new URL(url, import.meta.url));
    const definition = compileRecipeDefinition(parseYamlDocument(await readFile(path, "utf-8"), path), mechanicalRegistries);
    assert.equal(definition.kind, kind);
    assert.deepEqual(Object.keys(definition.actions), [...actions]);
    assert.ok(Object.values(definition.exports).some((item) => item.primary));
  }
});
