import { createJiti } from "jiti";
import { cpSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadManifest, parseAreaList, parseSystemList, planRuns, ROOT, unassignedTestFiles } from "./support/areas.mjs";

// Usage: node tests/run-ts-tests.mjs [--areas a,b|all] [--layer fast|e2e|all] [--systems s,t]
// Defaults: every area, both layers. See tests/areas.yaml.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const manifest = loadManifest();
const layer = args.get("layer") ?? "all";
if (!["fast", "e2e", "all"].includes(layer)) throw new Error(`--layer must be fast, e2e or all, got ${layer}`);
const { runs, skipped } = planRuns(manifest, {
  areas: parseAreaList(args.get("areas"), manifest),
  layers: layer === "all" ? ["fast", "e2e"] : [layer],
  systems: parseSystemList(args.get("systems")),
});
for (const skip of skipped) console.log(`not run here: ${skip.area}/${skip.layer} needs ${skip.need.join(", ")} (see tests/areas.yaml)`);
for (const file of unassignedTestFiles(manifest)) console.warn(`warning: ${file} is not in any area in tests/areas.yaml`);

// Process-wide environment, as before the area layout.
process.env.PYTHONDONTWRITEBYTECODE ??= "1";
process.env.PI_CAD_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), "pi-cad-workflow-home-"));
const testWorkflowRoot = join(process.env.PI_CAD_WORKFLOW_HOME, ".pi-cad", "workflows");
mkdirSync(testWorkflowRoot, { recursive: true });
cpSync(new URL("../workflow-packages/mechanical/default.yaml", import.meta.url), join(testWorkflowRoot, "mechanical-default.yaml"));

const files = runs.flatMap(({ dir }) => readdirSync(dir).filter((name) => /\.test\.(ts|mjs)$/.test(name)).sort().map((name) => resolve(dir, name)));
console.log(`running ${files.length} TS test files in ${runs.length} area directories`);

const jiti = createJiti(import.meta.url, { moduleCache: false });
for (const file of files) {
  if (file.endsWith(".mjs")) await import(file);
  else await jiti.import(file, { default: true });
}
