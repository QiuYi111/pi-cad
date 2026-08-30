import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const document = JSON.parse(readFileSync(new URL("../benchmarks/cadtestbench/adjudication/detailed-200-ambiguity.json", import.meta.url), "utf-8"));

test("detailed-200 ambiguity adjudication covers every sample exactly once", () => {
  assert.equal(document.samples.length, 200);
  assert.equal(new Set(document.samples.map((sample) => sample.sample_id)).size, 200);
  const counts = Object.fromEntries(["ambiguous", "borderline", "clear"].map((label) => [label, document.samples.filter((sample) => sample.label === label).length]));
  assert.deepEqual(counts, { ambiguous: 100, borderline: 10, clear: 90 });
  assert.deepEqual(document.counts, { ambiguous: 100, borderline: 10, clear: 90, total: 200 });
  for (const sample of document.samples.filter((item) => item.label !== "clear")) {
    assert.ok(sample.categories.length);
    assert.equal(sample.interpretations.length, 2);
    assert.ok(sample.minimal_question);
    assert.ok(sample.confidence > 0 && sample.confidence <= 1);
  }
});
