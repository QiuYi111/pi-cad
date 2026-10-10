import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { isCurrentReviewCompletion, persistedReviewNotificationIds, refineGateDecision } from "../../../src/integrations/prime/extension.ts";

test("Prime refine is blocked only while a canonical engineering workflow is active", () => {
  assert.equal(refineGateDecision(null), undefined);
  assert.equal(refineGateDecision({ complete: false, reason: "no canonical workflow run exists" }), undefined);
  assert.deepEqual(refineGateDecision({ complete: false, reason: "workflow running", runId: "run-1" }), { skip: true });
  assert.equal(refineGateDecision({ complete: true, reason: "workflow done", runId: "run-1" }), undefined);
});

test("Prime review notification identity survives resume and imported legacy messages", () => {
  assert.deepEqual(persistedReviewNotificationIds([
    {
      role: "custom",
      customType: "pi-cad.review-completed",
      content: "display text",
      details: { reviewId: "review-structured" },
    },
    {
      role: "custom",
      customType: "pi-cad.review-completed",
      content: "Pi-CAD independent review review-legacy completed with FAIL for commit-x.",
    },
    {
      role: "custom",
      customType: "unrelated",
      details: { reviewId: "review-ignore" },
    },
  ]), ["review-structured", "review-legacy"]);
});

test("Prime suppresses late completion events from superseded reviews", () => {
  const first = { reviewId: "review-1", subjectCommit: "commit-1", status: "fail" };
  const second = { reviewId: "review-2", subjectCommit: "commit-2", status: "pass" };
  assert.equal(isCurrentReviewCompletion(first, second), false);
  assert.equal(isCurrentReviewCompletion(first, null), false);
  assert.equal(isCurrentReviewCompletion(first, { ...first, status: "running" }), false);
  assert.equal(isCurrentReviewCompletion(first, first), true);
});
