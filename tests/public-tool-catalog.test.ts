import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { allPhaseContracts, contractTools } from "../src/control/phase-contract.ts";
import {
  ACTIVE_PUBLIC_TOOL_NAMES,
  HISTORICAL_TOOL_NAMES,
} from "../src/shared/public-tools.ts";

test("active catalog has no duplicate or historical names", () => {
  assert.equal(new Set(ACTIVE_PUBLIC_TOOL_NAMES).size, ACTIVE_PUBLIC_TOOL_NAMES.length);
  for (const name of HISTORICAL_TOOL_NAMES) {
    assert.ok(!ACTIVE_PUBLIC_TOOL_NAMES.includes(name as never), `${name} must remain historical only`);
  }
});

test("phase grants contain no historical tool and include analysis derivation with simulation", () => {
  const granted = new Set(allPhaseContracts().flatMap((contract) => contractTools(contract)));
  for (const name of HISTORICAL_TOOL_NAMES) assert.ok(!granted.has(name), `${name} is still granted`);
  assert.ok(granted.has("cad_derive_analysis_model"));
});

test("pi-cad-tools references cover every active public tool", () => {
  const referenceDir = fileURLToPath(new URL("../skills/pi-cad-tools/references/", import.meta.url));
  const markdown = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? markdown(join(directory, entry.name)) : entry.name.endsWith(".md") ? [join(directory, entry.name)] : []);
  const corpus = markdown(join(referenceDir, "generated"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const name of ACTIVE_PUBLIC_TOOL_NAMES) {
    assert.match(corpus, new RegExp(`\\b${name}\\b`), `pi-cad-tools does not cover ${name}`);
  }
  for (const name of HISTORICAL_TOOL_NAMES) {
    assert.ok(!corpus.includes(name), `active tool skill mentions historical name ${name}`);
  }
});

test("the skill surface includes the Prime Python capability and grilling skills", () => {
  const skillsDir = fileURLToPath(new URL("../skills/", import.meta.url));
  const names = readdirSync(skillsDir).sort();
  assert.deepEqual(names, [
    "assembly-design",
    "cad",
    "design-for-manufacturing",
    "grill-me",
    "mechanical-design",
    "parametric-cad-modeling",
    "pi-cad",
    "pi-cad-tools",
    "structural-analysis",
    "thermal-fluid-analysis",
  ]);
});
