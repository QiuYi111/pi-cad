import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateBenchmarkMetrics,
  failedEvaluationFromCadtests,
} from "../benchmarks/cadtestbench/metrics.mjs";

test("missing benchmark artifacts count every CADTest and requirement as failed", () => {
  const evaluation = failedEvaluationFromCadtests([
    { cadtest_id: 1, cadtest_type: "dimensions", requirement_id: "width", requirement_type: "dimension", requirement_description: "width" },
    { cadtest_id: 2, cadtest_type: "dimensions", requirement_id: "width", requirement_type: "dimension", requirement_description: "width" },
    { cadtest_id: 3, cadtest_type: "topology", requirement_id: "hole", requirement_type: "feature", requirement_description: "hole" },
  ]);
  assert.equal(evaluation.passed, 0);
  assert.equal(evaluation.total, 3);
  assert.equal(evaluation.exactPass, false);
  assert.deepEqual(evaluation.categories, {
    dimensions: { passed: 0, total: 2 },
    topology: { passed: 0, total: 1 },
  });
  assert.equal(evaluation.rsGroups.length, 2);
  assert.ok(evaluation.rsGroups.every((group) => !group.all_passed));
});

test("benchmark aggregation keeps failed samples in strict PR and RS denominators", () => {
  const metrics = aggregateBenchmarkMetrics([
    { evaluation: { passed: 3, total: 3, exactPass: true, rsGroups: [{ all_passed: true }] } },
    { evaluation: { passed: 0, total: 2, exactPass: false, rsGroups: [{ all_passed: false }, { all_passed: false }] } },
  ]);
  assert.deepEqual(metrics, {
    exact: 1,
    samples: 2,
    scorable_samples: 2,
    cadtests_passed: 3,
    cadtests_total: 5,
    rs_groups_passed: 1,
    rs_groups_total: 3,
  });
});

test("clarification-required samples are accepted but excluded from PR and RS denominators", () => {
  const metrics = aggregateBenchmarkMetrics([
    { evaluation: { passed: 2, total: 2, exactPass: true, rsGroups: [{ all_passed: true }] } },
    { evaluation: { status: "clarification_required", scorable: false, passed: 0, total: 0, exactPass: false, rsGroups: [] } },
  ]);
  assert.deepEqual(metrics, {
    exact: 1,
    samples: 2,
    scorable_samples: 1,
    cadtests_passed: 2,
    cadtests_total: 2,
    rs_groups_passed: 1,
    rs_groups_total: 1,
  });
});
