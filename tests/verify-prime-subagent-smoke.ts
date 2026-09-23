import assert from "node:assert/strict";
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
