import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controls = JSON.parse(readFileSync(new URL("../benchmarks/cadtestbench/controls/clarity-controls.json", import.meta.url), "utf-8"));

test("clarity controls cover the adjudicated ambiguous sample set with explicit contracts", () => {
  const expected = [
    "00001817", "00005721", "00006578", "00521969", "00670105",
    "00670268", "00984833", "00986712", "00995733", "00996001",
  ];
  assert.equal(controls.schema_version, 1);
  assert.deepEqual(controls.variants.map((item) => item.sample_id).sort(), expected.sort());
  assert.equal(new Set(controls.variants.map((item) => item.sample_id)).size, expected.length);

  const vague = /\b(?:slightly|approximately|close to|as desired|same side)\b/i;
  for (const variant of controls.variants) {
    assert.ok(variant.title);
    assert.ok(variant.resolutions.length >= 2, `${variant.sample_id} must document resolved ambiguity`);
    assert.ok(variant.complexity.length >= 1, `${variant.sample_id} must add contract complexity`);
    assert.match(variant.prompt, /exactly|authoritative|must/i, `${variant.sample_id} lacks normative language`);
    assert.match(variant.prompt, /STEP artifact with its Python source/);
    assert.doesNotMatch(variant.prompt, vague, `${variant.sample_id} retained vague spatial language`);
  }
});
