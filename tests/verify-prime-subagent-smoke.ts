import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapAgentApiContracts } from "../src/agent-api/bootstrap.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";

const cwd = process.argv[2];
if (!cwd) throw new Error("expected canonical Pi-CAD project directory");
bootstrapAgentApiContracts();
const project = new HarnessProjectStoreV7(cwd);
const { state } = await project.load();
assert.equal(state.currentRunId, null, "conversation-scoped Prime runs must not claim the project pointer");
assert.deepEqual(state.head.artifacts, {}, "child completion must not publish an implicit project candidate");
const bindings = Object.values(state.conversations ?? {});
assert.equal(bindings.length, 4, "parent, two children, and grandchild must own separate bindings");
assert.equal(new Set(bindings.map((binding) => binding.runId)).size, 4, "every conversation must own a unique run");
for (const binding of bindings) {
  const run = await new HarnessRunStoreV7(cwd, binding.runId).load(mechanicalRegistries);
  assert.ok(run, `run ${binding.runId} must load`);
  assert.equal(run.state.status, "done", `run ${binding.runId} must finish independently`);
}
const rootBinding = [...bindings].sort((left, right) => left.boundAt.localeCompare(right.boundAt))[0]!;
const rootRun = await new HarnessRunStoreV7(cwd, rootBinding.runId).load(mechanicalRegistries);
assert.ok(rootRun);
const index = await new HarnessRunStoreV7(cwd, rootBinding.runId).transactions.readJson<{ commits: string[] }>("workspace/commits/index.json");
assert.ok(index?.commits.length, "the parent must explicitly adopt the child outputs in its own workspace");
const adopted = await new HarnessRunStoreV7(cwd, rootBinding.runId).transactions.readJson<{ name: string; artifacts: Array<{ path: string; role: string }> }>(`workspace/commits/${index.commits.at(-1)}.json`);
assert.equal(adopted?.name, "adopted-subagent-results");
assert.deepEqual(adopted?.artifacts.map((artifact) => artifact.path).sort(), [
  "subagents/child-a/model.step",
  "subagents/child-b/model.step",
  "subagents/grandchild/model.step",
]);
const integration = JSON.parse(readFileSync(join(cwd, "subagents/child-a/integration-evidence.json"), "utf8")) as {
  artifacts: Array<{ path: string; sha256: string; probeHash?: string; observationId?: string }>;
  commit: { id: string; name: string; runId: string; artifacts: Array<{ path: string; sha256: string }> };
  identityV1: { pin_a: { path: string }; pin_b: { path: string }; hole_axis: { path: string }; rib_face: { path: string }; left_count: number; left_min_x: number; right_min_x: number; pin_a_volume: number };
  identityV2: { pin_a: { path: string; artifactHash: string; manifestHash: string }; pin_b: { path: string }; hole_axis: { path: string }; rib_face: { path: string }; left_count: number; left_min_x: number; right_min_x: number; pin_a_volume: number; old_ref_error: string };
  staleManifestError: string;
  featureFailure: string;
  timeoutError: string;
  workerFailure: string;
  motion: { sampleCount: number; endpointsClear: boolean; firstFailure: number | null; maximumPenetration: number; passed: boolean; coverage: string; booleanFailure: string; comparison: { poseCount: number; repeatedImportCount: number; repeatedImportSeconds: number; batchedSubjectImportCount: number; batchSeconds: number; batchJsonBytes: number }; batch: { evaluated: number; skipped: number; errors: number; coverage: string } };
  done: { status: string; artifactHash: string; observationId: string; probe: { path: string; ref: string; solid_count: number } };
};
assert.equal(integration.artifacts.length, 3);
assert.deepEqual(integration.artifacts.map((artifact) => artifact.path), [
  "subagents/child-a/assembly-v1.step",
  "subagents/child-a/assembly-v2.step",
  "subagents/child-a/clearance.step",
]);
for (const artifact of integration.artifacts) assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
assert.equal(integration.artifacts[0]?.probeHash, integration.artifacts[0]?.sha256);
assert.equal(integration.artifacts[1]?.probeHash, integration.artifacts[1]?.sha256);
assert.ok(integration.artifacts[0]?.observationId);
assert.ok(integration.artifacts[1]?.observationId);
assert.equal(integration.commit.name, "named-assembly-evidence");
assert.match(integration.commit.runId, /^v7-/);
assert.deepEqual(integration.commit.artifacts, [{ path: integration.artifacts[1]?.path, sha256: integration.artifacts[1]?.sha256 }]);
assert.equal(integration.identityV1.pin_a.path, "arm/pin_a");
assert.equal(integration.identityV1.pin_b.path, "arm/pin_b");
assert.equal(integration.identityV2.pin_a.path, "arm/pin_a");
assert.equal(integration.identityV2.pin_b.path, "arm/pin_b");
assert.equal(integration.identityV1.hole_axis.path, "arm/pin_a/hole_axis");
assert.equal(integration.identityV2.hole_axis.path, "arm/pin_a/hole_axis");
assert.equal(integration.identityV1.rib_face.path, "arm/bracket_left/rib_face");
assert.equal(integration.identityV2.rib_face.path, "arm/bracket_left/rib_face");
assert.equal(integration.identityV1.left_count, 2);
assert.equal(integration.identityV2.left_count, 2);
assert.equal(integration.identityV1.left_min_x, 0);
assert.equal(integration.identityV2.left_min_x, 0);
assert.equal(integration.identityV1.right_min_x, 40);
assert.equal(integration.identityV2.right_min_x, 40);
assert.ok(Math.abs(integration.identityV1.pin_a_volume - 125.663706) < 0.01);
assert.ok(Math.abs(integration.identityV2.pin_a_volume - 282.743339) < 0.01);
assert.equal(integration.identityV2.old_ref_error, "unknown-ref");
assert.match(integration.staleManifestError, /identity manifest.*belongs to artifact/);
assert.ok(integration.featureFailure.length > 0, "a missing named feature must fail the real model build");
assert.match(integration.timeoutError, /probe exceeded 25s|CPU wall limit/i);
assert.match(integration.workerFailure, /injected interference worker failure/);
assert.match(integration.motion.booleanFailure, /boolean common failed.*unresolved/i);
assert.equal(integration.motion.sampleCount, 21);
assert.equal(integration.motion.endpointsClear, true);
assert.notEqual(integration.motion.firstFailure, null);
assert.ok(integration.motion.maximumPenetration > 0);
assert.equal(integration.motion.passed, false);
assert.match(integration.motion.coverage, /discrete poses/);
assert.deepEqual([integration.motion.comparison.poseCount, integration.motion.comparison.repeatedImportCount, integration.motion.comparison.batchedSubjectImportCount], [10, 10, 1]);
assert.ok(integration.motion.comparison.repeatedImportSeconds >= 0);
assert.ok(integration.motion.comparison.batchSeconds >= 0);
assert.ok(integration.motion.comparison.batchJsonBytes > 0);
assert.deepEqual([integration.motion.batch.evaluated, integration.motion.batch.skipped, integration.motion.batch.errors], [10, 0, 0]);
assert.match(integration.motion.batch.coverage, /no claim between samples/);
assert.equal(integration.done.status, "done");
assert.equal(integration.done.probe.path, "arm/pin_a");
assert.ok(integration.done.probe.ref.length > 0);
assert.ok(integration.done.probe.solid_count > 0);
assert.equal(integration.done.artifactHash, integration.artifacts[1]?.sha256);
assert.ok(integration.done.observationId);
const integrationCommitPath = join(
  process.env.PI_CAD_CANONICAL_PROJECT_DIR ?? join(cwd, ".pi-cad"),
  "runs",
  integration.commit.runId,
  "workspace/commits",
  `${integration.commit.id}.json`,
);
assert.ok(existsSync(integrationCommitPath), "the named ArtifactRef commit must belong to the child canonical run");
const committedIntegration = JSON.parse(readFileSync(integrationCommitPath, "utf8")) as { id: string; name: string; artifacts: Array<{ path: string; sha256: string }> };
assert.equal(committedIntegration.id, integration.commit.id);
assert.equal(committedIntegration.name, integration.commit.name);
assert.deepEqual(committedIntegration.artifacts.map(({ path, sha256 }) => ({ path, sha256 })), integration.commit.artifacts);
const projectRoot = resolve(process.env.PI_CAD_REPO ?? process.cwd());
const blenderVerification = spawnSync(join(projectRoot, "python/.venv/bin/python"), [
  join(projectRoot, "tests/res406-verify-blender-bridge.py"),
  join(cwd, integration.artifacts[1]!.path),
], { cwd: projectRoot, encoding: "utf8", timeout: 150_000, env: { ...process.env, PYTHONPATH: join(projectRoot, "python") } });
assert.equal(blenderVerification.status, 0, `${blenderVerification.stderr}\n${blenderVerification.stdout}`);
const blenderBridge = JSON.parse(blenderVerification.stdout.trim()) as { stepSha256: string; identityManifestSha256: string; occurrences: string[]; objectCount: number };
assert.equal(blenderBridge.stepSha256, integration.artifacts[1]?.sha256);
assert.equal(integration.identityV2.pin_a.artifactHash, blenderBridge.stepSha256);
assert.equal(integration.identityV2.pin_a.manifestHash, blenderBridge.identityManifestSha256);
console.log(JSON.stringify({ integrationArtifacts: integration.artifacts, integrationCommit: integration.commit, motion: integration.motion, done: integration.done, blenderBridge }));
