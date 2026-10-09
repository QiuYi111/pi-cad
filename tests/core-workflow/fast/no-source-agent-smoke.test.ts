import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { isCurrentReviewCompletion, persistedReviewNotificationIds, refineGateDecision } from "../../../src/integrations/prime/extension.ts";

test("Prime CAD skill forbids nested Python adaptation and maps CadQuery tasks to the managed backend", async () => {
  const skill = await readFile(join(process.cwd(), "skills", "cad", "SKILL.md"), "utf-8");
  assert.match(skill, /Never launch a nested[\s\S]*`python`\/`python3`/i);
  assert.match(skill, /CadQuery[\s\S]*implement the managed candidate with `cad\.part`, or with build123d only/i);
  assert.match(skill, /never use a subprocess as an API-adaptation fallback/i);
  assert.match(skill, /complete public signatures[\s\S]*cad\.model\.build[\s\S]*cad\.probe\.run[\s\S]*cad\.review\.submit/i);
  assert.match(skill, /There is no\s+reason to call `inspect\.signature\(\)`/i);
  assert.match(skill, /Every rebuild must overwrite[\s\S]*artifact = await cad\.model\.build/i);
  assert.match(skill, /cad\.plan\.current\(\)/i);
  assert.match(skill, /cad\.review\.prepare\(candidate\)/i);
  assert.match(skill, /candidate_defect[\s\S]*plan_stale[\s\S]*missing_evidence/i);
  assert.match(skill, /Do not spawn[\s\S]*reviewers by default/i);
});

test("Prime review completion uses ExtensionAPI messaging rather than event context", async () => {
  const extension = await readFile(join(process.cwd(), "src", "integrations", "prime", "extension.ts"), "utf-8");
  assert.match(extension, /pi\.sendMessage\(/);
  assert.match(extension, /Summary: \$\{result\.summary\}/);
  assert.match(extension, /result\?\.findings/);
  assert.match(extension, /finding\.evidenceRefs/);
  assert.doesNotMatch(extension, /ctx\.sendMessage\(/);
  assert.doesNotMatch(extension, /else if \(current\) await notifyReview/);
  assert.match(extension, /persistedReviewNotificationIds\(event\.messages\)/);
  assert.match(extension, /op: "review-current"/);
  assert.match(extension, /pi\.sendMessage\(reviewCompletionMessage\(current\), \{ deliverAs: "steer" \}\)/);
  assert.match(extension, /pi\.on\("session_before_refine"/);
  assert.match(extension, /op: "completion-gate"/);
});

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

test("published Prime entrypoints contain no development-plan or checkout-specific defaults", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf-8"));
  const setup = await readFile(join(process.cwd(), "scripts", "prime-cad.mjs"), "utf-8");
  const launcher = await readFile(join(process.cwd(), "scripts", "prime-cad-launcher.sh"), "utf-8");
  assert.equal(packageJson.scripts["prime:setup"], "node scripts/prime-cad.mjs");
  assert.equal(packageJson.scripts["prime:plan-c"], undefined);
  assert.doesNotMatch(`${setup}\n${launcher}`, /plan[ -]?c|\/home\/jingyi/i);
  assert.match(setup, /\.prime\/agent/);
});
