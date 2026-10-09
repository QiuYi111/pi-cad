import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { loadManifest, parseAreaList, parseSystemList, planRuns, ROOT } from "./support/areas.mjs";

// Usage: node tests/run-py-tests.mjs [--areas a,b|all] [--layer fast|e2e|all]
//          [--systems s,t] [--python <interpreter>] [--extra <uv extra>]
// Runs `unittest discover` once per area directory (each is its own top-level),
// so names and sys.path stay as they were per directory. Without --python it
// runs through the uv project in python/.
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

const interpreter = args.get("python")
  ? [args.get("python")]
  : ["uv", "run", "--offline", "--frozen", "--project", "python", ...(args.get("extra") ? ["--extra", args.get("extra")] : []), "python"];
const env = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONPATH: [`${ROOT}/skills/cad/src`, `${ROOT}/tests/support`, process.env.PYTHONPATH].filter(Boolean).join(":"),
};

let failed = 0;
for (const { area, layer: runLayer, dir } of runs) {
  if (!existsSync(dir) || !readdirSync(dir).some((name) => /^test_.*\.py$/.test(name))) continue;
  const label = `${area}/${runLayer} ${dir.slice(ROOT.length + 1)}`;
  console.log(`--- python: ${label}`);
  const [command, ...prefix] = interpreter;
  const result = spawnSync(command, [...prefix, "-m", "unittest", "discover", "-s", dir, "-t", dir, "-p", "test_*.py"], {
    cwd: ROOT,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${label}`);
  }
}
if (failed) process.exit(1);
