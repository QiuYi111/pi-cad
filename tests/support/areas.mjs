// Reads the area manifest (tests/areas.yaml) and plans test runs for the TS and
// Python runners and for scripts/select-areas.mjs. Node only, no dependencies
// beyond the root `yaml` package.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LAYERS = ["fast", "e2e"];

export function loadManifest(path = resolve(ROOT, "tests/areas.yaml")) {
  const manifest = parse(readFileSync(path, "utf8"));
  if (!manifest || typeof manifest.areas !== "object") throw new Error(`${path}: missing areas`);
  for (const [name, area] of Object.entries(manifest.areas)) {
    if (!Array.isArray(area.src)) throw new Error(`${path}: area ${name} needs src globs`);
    for (const layer of LAYERS) {
      if (!Array.isArray(area.tests?.[layer] ?? [])) throw new Error(`${path}: area ${name} tests.${layer} must be a list`);
    }
    area.real = area.real ?? [];
    area.tests = { fast: area.tests?.fast ?? [], e2e: area.tests?.e2e ?? [] };
  }
  manifest.shared = manifest.shared ?? [];
  manifest.outside_areas = manifest.outside_areas ?? [];
  return manifest;
}

// Glob to RegExp for repo-relative POSIX paths: ** crosses directories, * and ? do not.
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

// A manifest entry may name a directory; it then covers everything below it.
export function matchesAny(file, globs) {
  return globs.some((glob) => globToRegExp(glob.endsWith("/") ? `${glob}**` : glob).test(file));
}

// Which areas a list of changed repo-relative files touches. `shared` paths select every area.
export function selectAreas(manifest, files) {
  const names = Object.keys(manifest.areas);
  const reasons = new Map();
  const add = (area, file, why) => {
    if (!reasons.has(area)) reasons.set(area, []);
    reasons.get(area).push(`${file} (${why})`);
  };
  for (const raw of files) {
    const file = raw.trim().split(sep).join("/");
    if (!file) continue;
    if (matchesAny(file, manifest.shared)) {
      for (const name of names) add(name, file, "shared");
      continue;
    }
    for (const [name, area] of Object.entries(manifest.areas)) {
      if (matchesAny(file, area.src)) add(name, file, "src");
      else if (matchesAny(file, [...area.tests.fast, ...area.tests.e2e].map((dir) => `${dir}/`))) add(name, file, "tests");
    }
  }
  return { areas: names.filter((name) => reasons.has(name)), reasons };
}

// Parses a comma list. "all" or an absent value means every area; "" means none.
export function parseAreaList(value, manifest) {
  if (value === undefined || value === "all") return Object.keys(manifest.areas);
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) if (!manifest.areas[name]) throw new Error(`unknown area: ${name} (see tests/areas.yaml)`);
  return names;
}

export function parseSystemList(value) {
  if (value === undefined) return null;
  return value.split(",").map((name) => name.trim()).filter(Boolean);
}

// Turns the manifest and CLI selection into the directories to run.
// Returns { runs: [{ area, layer, dir }], skipped: [{ area, layer, dir, need }] }.
// An e2e run whose area needs a real system outside the --systems list is
// reported as skipped by the runner, not run; without --systems every run is planned.
export function planRuns(manifest, { areas, layers = LAYERS, systems = null }) {
  const runs = [];
  const skipped = [];
  for (const area of areas) {
    for (const layer of layers) {
      const dirs = manifest.areas[area].tests[layer];
      for (const rel of dirs) {
        const dir = resolve(ROOT, rel);
        if (!existsSync(dir)) continue;
        if (layer === "e2e" && systems) {
          const missing = manifest.areas[area].real.filter((system) => !systems.includes(system));
          if (missing.length) {
            skipped.push({ area, layer, dir: relative(ROOT, dir), need: missing });
            continue;
          }
        }
        runs.push({ area, layer, dir });
      }
    }
  }
  return { runs, skipped };
}

// Top-level test files in tests/ that no area claims and that are not run by another runner.
export function unassignedTestFiles(manifest) {
  const testsDir = resolve(ROOT, "tests");
  const outside = manifest.outside_areas.map((glob) => globToRegExp(glob));
  const found = [];
  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.test\.(ts|mjs)$/.test(entry.name)) continue;
    const rel = `tests/${entry.name}`;
    if (outside.some((re) => re.test(rel))) continue;
    found.push(rel);
  }
  return found;
}
