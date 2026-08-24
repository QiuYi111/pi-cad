import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { compileRecipeDefinition } from "../../../harness/recipe/compiler.ts";
import type { RecipeDefinitionV1 } from "../../../harness/recipe/types.ts";
import type { RegistrySet } from "../../../harness/registry.ts";
import type { LoadedSimulationRecipe } from "../../../modules/simulate-v2/protocol.ts";

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  };
  await visit(root);
  return files.sort();
}

/** Read-only adapter while builtin pi-sim.toml assets migrate to pi-recipe.yaml. */
export async function adaptSimulationV2Recipe(input: {
  recipe: LoadedSimulationRecipe;
  backend: string;
  runtime: string;
  registries: RegistrySet;
}): Promise<RecipeDefinitionV1> {
  const runtimeProfile = `${input.backend}/${input.runtime}`;
  const registration = input.registries.runtimeProfiles.require(runtimeProfile);
  const limits = (registration.contract.semantics as Record<string, any>).limits as { cpu: number; memoryGiB: number; wallHours: number; workspaceGiB: number };
  const allFiles = await filesUnder(input.recipe.recipeRoot);
  const observerFiles = new Set(["pi-sim.toml", ...input.recipe.manifest.observationFiles]);
  const computeFiles = allFiles.filter((path) => !observerFiles.has(path));
  if (!computeFiles.length) throw new Error("Simulation V2 adapter found no compute files");
  const value = {
    schema: 1,
    id: `simulation-v2/${input.recipe.recipePath.replaceAll("/", "-")}`,
    version: "1.0.0",
    kind: "simulation",
    runtimeProfile,
    inputs: input.recipe.inputs.map((item) => ({ path: item.projectPath, role: item.declaration, type: item.kind })),
    actions: { run: { argv: ["/bin/bash", "-lc", input.recipe.manifest.entrypoint], files: computeFiles, timeoutSeconds: Math.round(limits.wallHours * 3600) } },
    observer: { argv: ["/bin/bash", "-lc", input.recipe.manifest.observe], files: [...observerFiles].sort(), timeoutSeconds: Math.min(3600, Math.round(limits.wallHours * 3600)) },
    exports: Object.fromEntries(Object.entries(input.recipe.manifest.exports).map(([name, item]) => [name, { type: item.type, primary: item.primary, ...(item.unit ? { unit: item.unit } : {}) }])),
    resources: { cpu: limits.cpu, memoryGiB: limits.memoryGiB, workspaceGiB: limits.workspaceGiB },
  };
  return compileRecipeDefinition(value, input.registries);
}
