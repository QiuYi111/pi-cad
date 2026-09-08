import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { executeWorkflowGitActions, prepareWorkflowGit } from "../src/authority/workflow-git.ts";
import type { WorkflowSnapshotV1 } from "../src/harness/workflow/types.ts";
import { handleAgentApi } from "../src/agent-api/handlers.ts";

const run = promisify(execFile);

function workflow(): WorkflowSnapshotV1 {
  return {
    schema: 1, id: "test.git", version: "1.0.0", hash: "a".repeat(64), parametersSchema: {}, initialPhase: "work",
    versionControl: { init: true },
    phases: { work: { purpose: "work", actions: [], grants: [], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: [], hooks: [], transitions: {}, terminal: true } },
  };
}

test("workflow Git initializes and commits only source changed after its baseline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "reify-git-"));
  await writeFile(join(cwd, "existing.py"), "value = 1\n");
  await writeFile(join(cwd, "old.step"), "old model\n");
  const definition = workflow();
  const prepared = await prepareWorkflowGit(cwd, definition);
  assert.equal(prepared[0]?.action, "init");

  await writeFile(join(cwd, "existing.py"), "value = 2\n");
  await writeFile(join(cwd, "new.py"), "result = 3\n");
  await writeFile(join(cwd, "new.step"), "generated model\n");
  await writeFile(join(cwd, "credentials.json"), "{\"token\":\"do-not-commit\"}\n");
  const result = await executeWorkflowGitActions(cwd, definition, ["commit"], "complete work");
  assert.deepEqual(result[0]?.files, ["existing.py", "new.py"]);
  const { stdout } = await run("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd });
  assert.deepEqual(stdout.trim().split("\n").sort(), ["existing.py", "new.py"]);
  assert.equal(await readFile(join(cwd, "new.step"), "utf8"), "generated model\n");
  assert.equal(await readFile(join(cwd, "credentials.json"), "utf8"), "{\"token\":\"do-not-commit\"}\n");
});

test("workflow Git refuses remote actions unless explicitly enabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "reify-git-"));
  const definition = workflow();
  await prepareWorkflowGit(cwd, definition);
  await assert.rejects(() => executeWorkflowGitActions(cwd, definition, ["push"], "release"), /allowRemote/);
});

test("workspace commits bind the Git revision created for the phase record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "reify-git-api-"));
  await writeFile(join(cwd, "design.py"), "size = 1\n");
  await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.default" });
  await writeFile(join(cwd, "design.py"), "size = 2\n");
  const manifest = await handleAgentApi(cwd, { schema: 1, op: "commit", name: "plan" }) as { sourceRevision?: string };
  assert.match(manifest.sourceRevision ?? "", /^[a-f0-9]{40}$/);
  const { stdout } = await run("git", ["show", `${manifest.sourceRevision}:design.py`], { cwd });
  assert.equal(stdout, "size = 2\n");
});

test("workspace commits preserve small parameter manifests needed for isolated rebuilds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "reify-git-parameters-"));
  await writeFile(join(cwd, "design.py"), "size = 8\n");
  await run("git", ["init"], { cwd });
  await run("git", ["add", "design.py"], { cwd });
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "source"], { cwd });
  await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.naked" });
  const manifest = { schema: 1, modelId: "plate", source: { path: "design.py", sha256: "a".repeat(64), entrypoint: "build" }, output: { path: "build/plate.step", sha256: "b".repeat(64) }, parameters: [{ id: "hole", type: "number", default: 8, value: 8, unit: "mm" }] };
  await writeFile(join(cwd, "parameters.json"), JSON.stringify(manifest));
  const committed = await handleAgentApi(cwd, { schema: 1, op: "commit", name: "hole-8", artifacts: [{ path: "parameters.json", role: "model-parameter-manifest" }], acceptance: {
    requirements: [
      { id: "mount-hole-diameter-8mm", category: "geometry", status: "unverified", method: "cylindrical face radius probe" },
      { id: "overall-envelope-40x24x12mm", category: "geometry", status: "unverified", method: "bounding box inspection" },
    ], assumptions: ["dimensions are interpreted in millimetres"],
  } }) as { artifactSnapshots?: Record<string, unknown>; acceptanceSummary?: { requirements: Array<{ id: string; status: string; category: string }>; assumptions: string[] } };
  assert.equal(Object.keys(committed.artifactSnapshots ?? {}).length, 1);
  assert.ok(committed.acceptanceSummary?.requirements.some((item) => item.status === "unverified"), "an omitted check must remain visibly unverified");
  assert.ok(committed.acceptanceSummary?.requirements.some((item) => item.category === "geometry"));
  assert.equal(committed.acceptanceSummary?.requirements.find((item) => item.id.includes("envelope"))?.status, "unverified");
  assert.deepEqual(committed.acceptanceSummary?.assumptions, ["dimensions are interpreted in millimetres"]);
  await assert.rejects(() => handleAgentApi(cwd, { schema: 1, op: "commit", name: "false-pass", acceptance: { requirements: [{ id: "hole", category: "geometry", status: "verified", method: "probe", evidenceRef: "missing-evidence" }] } }), /lacks current-version evidence/);
  const catalog = await handleAgentApi(cwd, { schema: 1, op: "viewer-catalog" }) as { parameterManifests: Array<{ path: string; manifest: { modelId: string } }> };
  assert.ok(catalog.parameterManifests.some((item) => item.path.includes("@commit/") && item.manifest.modelId === "plate"));
});
