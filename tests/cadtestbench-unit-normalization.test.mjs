import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { legacyEvaluatorScale, normalizePhysicalUnitPrompt, physicalUnitIndex } from "../benchmarks/cadtestbench/unit-normalization.mjs";

const document = JSON.parse(readFileSync(new URL("../benchmarks/cadtestbench/adjudication/detailed-200-units.json", import.meta.url), "utf-8"));

test("physical-unit adjudication covers exactly eight samples and normalizes prompts to STEP millimetres", () => {
  const index = physicalUnitIndex(document);
  assert.equal(index.size, 8);
  const metres = index.get("00031181");
  const prompt = normalizePhysicalUnitPrompt("Create a 0.61135 metre block.", metres);
  assert.match(prompt, /611\.35 mm/);
  assert.match(prompt, /supersede the source-unit numerals/);
  assert.equal(legacyEvaluatorScale(metres), 0.001);
  const inches = index.get("00983173");
  assert.equal(legacyEvaluatorScale(inches), 1 / 25.4);
});

test("abstract model-unit prompts remain byte-for-byte unchanged", () => {
  const prompt = "Create a 0.75 unit cylinder.";
  assert.equal(normalizePhysicalUnitPrompt(prompt, undefined), prompt);
});
