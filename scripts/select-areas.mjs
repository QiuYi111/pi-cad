#!/usr/bin/env node
// Prints the test areas (tests/areas.yaml) that a list of changed files touches,
// comma-separated, on one line. A shared path (src/harness, src/shared, src/agent-api,
// lockfiles, the runners, CI workflows) selects every area.
//
//   git diff --name-only origin/master...HEAD | node scripts/select-areas.mjs
//   node scripts/select-areas.mjs path/to/file.ts another/file.py
//   node scripts/select-areas.mjs --all         # every area (push, nightly)
//   add --explain to print why each area was selected, on stderr
import { readFileSync } from "node:fs";
import { loadManifest, selectAreas } from "../tests/support/areas.mjs";

const argv = process.argv.slice(2);
const explain = argv.includes("--explain");
const paths = argv.filter((arg) => !arg.startsWith("--"));
const manifest = loadManifest();

if (argv.includes("--all")) {
  console.log(Object.keys(manifest.areas).join(","));
  process.exit(0);
}
let files = paths;
if (paths.length === 0 && !process.stdin.isTTY) files = readFileSync(0, "utf8").split("\n");

const { areas, reasons } = selectAreas(manifest, files);
if (explain) {
  for (const area of areas) for (const why of reasons.get(area)) console.error(`${area}: ${why}`);
}
console.log(areas.join(","));
