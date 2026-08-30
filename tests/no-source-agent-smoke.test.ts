import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { renderCurrentActionCard } from "../src/core/agent-contract.ts";
import { persistedReviewNotificationIds } from "../src/integrations/prime/extension.ts";

function nextActionFromInstalledContext(actionCard: string): string {
  const line = actionCard.split(/\r?\n/).find((item) => item.startsWith("Recommended next action:"));
  if (!line) throw new Error("installed action card has no recommendation");
  return line.slice("Recommended next action:".length).trim();
}

function state(overrides: Record<string, unknown>) {
  return {
    schemaVersion: 6, runId: "r", projectId: "p", createdAt: "x", updatedAt: "x",
    route: null, phase: "intake", status: "active", mutationPolicy: "read_only",
    phaseRecords: [], evidence: [], staleEvidence: [], activeWorkstreams: [], ...overrides,
  } as any;
}

test("installed contract/skills/action cards drive representative decisions without source lookup", async () => {
  const contract = JSON.parse(await readFile(join(process.cwd(), "assets", "agent-contract.json"), "utf-8"));
  const cookbook = await readFile(join(process.cwd(), "skills", "pi-cad-tools", "references", "cookbooks", "simulation-recipes.md"), "utf-8");
  assert.ok(contract.tools.every((tool: { inputSchema?: unknown }) => tool.inputSchema));
  assert.match(cookbook, /Recipe directory/i);
  assert.doesNotMatch(cookbook, /read .*src\//i);

  assert.match(nextActionFromInstalledContext(renderCurrentActionCard(state({}))), /cad_route/);
  assert.match(nextActionFromInstalledContext(renderCurrentActionCard(state({ route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" }, phase: "requirements" }))), /cad_commit_requirements/);
  const review = renderCurrentActionCard(state({
    route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" },
    phase: "review", currentArtifactPath: "build/part.step", currentArtifactHash: "a".repeat(64),
    evidenceObligations: { simulation: { disposition: "required", cases: [{ id: "load-case", tool: "cad_simulate" }] } },
  }), "## Ready managed runtimes\n- backend=torch-fem runtime=torch-fem-0.9-cu126 actual=cuda");
  assert.match(nextActionFromInstalledContext(review), /simulate\/observe|case Recipe/i);
  assert.match(review, /simulation:load-case/);
  assert.match(review, /actual=cuda/);
  assert.doesNotMatch(review, /read src\//i);
});

test("Prime CAD skill forbids nested Python adaptation and maps CadQuery tasks to the managed backend", async () => {
  const skill = await readFile(join(process.cwd(), "skills", "cad", "SKILL.md"), "utf-8");
  assert.match(skill, /Never launch a nested[\s\S]*`python`\/`python3`/i);
  assert.match(skill, /CadQuery[\s\S]*implement the managed candidate with build123d/i);
  assert.match(skill, /never use a subprocess as an API-adaptation fallback/i);
  assert.match(skill, /complete public signatures[\s\S]*cad\.model\.build[\s\S]*cad\.probe\.run[\s\S]*cad\.review\.submit/i);
  assert.match(skill, /There is no\s+reason to call `inspect\.signature\(\)`/i);
  assert.match(skill, /Every rebuild must overwrite[\s\S]*artifact = await cad\.model\.build/i);
  assert.match(skill, /review\.submit\(\).*accepts the returned `Commit`/i);
  assert.match(skill, /do not rediscover or guess commit identifiers/i);
  assert.match(skill, /parent=final_commit[\s\S]*artifacts=list\(final_commit\.artifacts\)/i);
  assert.match(skill, /phase obligation ->[\s\S]*build -> probe -> review-candidate commit -> transition -> review\.submit/i);
  assert.match(skill, /parts-geometry[\s\S]*parts-visual[\s\S]*never call `cad\.commit` with those names/i);
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
  assert.match(extension, /resumedReviewMessage = reviewCompletionMessage\(current\)/);
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

test("published Prime entrypoints contain no development-plan or checkout-specific defaults", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf-8"));
  const setup = await readFile(join(process.cwd(), "scripts", "prime-cad.mjs"), "utf-8");
  const launcher = await readFile(join(process.cwd(), "scripts", "prime-cad-launcher.sh"), "utf-8");
  assert.equal(packageJson.scripts["prime:setup"], "node scripts/prime-cad.mjs");
  assert.equal(packageJson.scripts["prime:plan-c"], undefined);
  assert.doesNotMatch(`${setup}\n${launcher}`, /plan[ -]?c|\/home\/jingyi/i);
  assert.match(setup, /\.prime\/agent/);
});
