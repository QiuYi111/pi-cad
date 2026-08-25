import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPrimeBwrapArgs, buildReviewerBwrapArgs, type LaunchPaths } from "../src/authority/launcher.ts";
import { completionGate, dispatchSidecarRequest, startAuthoritySidecar } from "../src/authority/sidecar.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("authority sidecar owns canonical state and rewrites a non-authoritative workspace projection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-project-"));
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-canonical-"));
  const runtime = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-runtime-"));
  const previous = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  const sidecar = await startAuthoritySidecar({ cwd, runtimeDirectory: runtime });
  try {
    assert.notEqual(sidecar.authorSocket, sidecar.reviewerSocket);
    assert.equal((await stat(sidecar.authorSocket)).mode & 0o777, 0o600);
    assert.equal((await stat(sidecar.reviewerSocket)).mode & 0o777, 0o600);
    const started = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" });
    assert.equal(started.ok, true);
    assert.ok((await readdir(canonical)).includes("v7-project"));
    assert.deepEqual(await readdir(join(cwd, ".pi-cad")), ["status.json"]);
    const statusPath = join(cwd, ".pi-cad", "status.json");
    const projection = JSON.parse(await readFile(statusPath, "utf-8"));
    assert.equal(projection.authoritative, false);
    assert.equal(projection.run.phase, "grill");

    await chmod(statusPath, 0o644);
    await writeFile(statusPath, '{"authoritative":true,"run":{"phase":"release"}}\n');
    const current = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-current" });
    assert.equal(current.ok, true);
    assert.equal((current.result as any).phase, "grill");
    assert.equal(JSON.parse(await readFile(statusPath, "utf-8")).authoritative, false);

    const denied = await dispatchSidecarRequest("reviewer", cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" });
    assert.equal(denied.ok, false);
    assert.match(denied.error?.message ?? "", /reviewer endpoint does not expose/);
    const malformed = await dispatchSidecarRequest("author", cwd, { schema: 2, op: "workflow-current" });
    assert.equal(malformed.ok, false);
  } finally {
    await sidecar.close();
    if (previous === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("workspace projection symlinks cannot redirect sidecar writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-outside-"));
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-canonical-"));
  const runtime = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-runtime-"));
  const previous = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  await symlink(outside, join(cwd, ".pi-cad"));
  const sidecar = await startAuthoritySidecar({ cwd, runtimeDirectory: runtime });
  try {
    const response = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" });
    assert.equal(response.ok, true);
    assert.deepEqual(await readdir(outside), []);
    assert.ok((await readdir(canonical)).includes("v7-project"));
  } finally {
    await sidecar.close();
    if (previous === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("completion gate requires terminal state, release commit, and a PASS bound to that release", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-completion-gate-"));
  try {
    const workflow = compileWorkflowDefinition({
      schema: 1,
      id: "test/completion-gate",
      version: "1.0.0",
      parametersSchema: {},
      initialPhase: "release",
      phases: {
        release: {
          purpose: "Release",
          actions: ["cad_commit"],
          grants: ["commit_plan"],
          writeScopes: ["run:record", "run:state"],
          recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
        },
      },
    }, mechanicalRegistries);
    const project = new HarnessProjectStoreV7(cwd);
    const initial = await project.startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    assert.equal((await completionGate(cwd)).complete, false);
    const releaseHash = "a".repeat(64);
    await new HarnessRunStoreV7(cwd, initial.state.runId).mutate(mechanicalRegistries, ({ state, registryContract }) => ({
      state: {
        ...state,
        status: "done",
        records: {
          release: { obligationRef: "release", type: "workspace_commit", path: "commits/release.json", sha256: releaseHash, workflowHash: workflow.hash, createdAt: new Date().toISOString() },
        },
        latestReview: {
          id: "review-final", verdict: "pass", path: "reviews/final.json", profileId: "fresh",
          subjectHash: releaseHash, workflowHash: workflow.hash, registryContractHash: registryContract.hash,
        },
      },
      event: { type: "TestCompleted" },
    }));
    assert.equal((await completionGate(cwd)).complete, true);
    await new HarnessRunStoreV7(cwd, initial.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, latestReview: { ...state.latestReview!, subjectHash: "b".repeat(64) } },
      event: { type: "TestReviewStaled" },
    }));
    const stale = await completionGate(cwd);
    assert.equal(stale.complete, false);
    assert.match(stale.reason, /another release/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Prime bwrap mounts only the author endpoint and selected read-only Pi-CAD surfaces", () => {
  const paths: LaunchPaths = {
    repository: "/repo/pi-cad",
    project: "/project",
    primeRoot: "/repo/prime",
    nodeRoot: "/runtime/node",
    primeAgentDir: "/host/agent",
    primeKernelVenv: "/host/kernel",
    kernelPythonRoot: "/runtime/python",
    kernelPythonExecutable: "python3.11",
    kernelSitePackages: "lib/python3.11/site-packages",
    runtimeDirectory: "/run/private",
    ephemeralAgentDir: "/run/private/prime-agent",
    authorSocketDirectory: "/run/private/author",
  };
  const args = buildPrimeBwrapArgs(paths, ["--print", "build it"]);
  const joined = args.join("\n");
  assert.match(joined, /--bind\n\/project\n\/workspace/);
  assert.match(joined, /--ro-bind\n\/run\/private\/author\n\/run\/pi-cad\/author/);
  assert.doesNotMatch(joined, /reviewer/);
  assert.doesNotMatch(joined, /PI_CAD_CANONICAL_PROJECT_DIR/);
  assert.doesNotMatch(joined, /\/host\/agent/);
  assert.doesNotMatch(joined, /--ro-bind\n\/repo\/pi-cad\n/);
  assert.match(joined, /--tmpfs\n\/tmp/);
  assert.match(joined, /--setenv\nHOME\n\/home\/prime/);
});

test("reviewer bwrap is subject-scoped and cannot see the author workspace or endpoint", () => {
  const paths: LaunchPaths = {
    repository: "/repo/pi-cad", project: "/author-project", primeRoot: "/repo/prime", nodeRoot: "/runtime/node",
    primeAgentDir: "/host/agent", primeKernelVenv: "/host/kernel", kernelPythonRoot: "/runtime/python",
    kernelPythonExecutable: "python3.11", kernelSitePackages: "lib/python3.11/site-packages", runtimeDirectory: "/run/private",
    ephemeralAgentDir: "/run/private/prime-agent", authorSocketDirectory: "/run/private/author",
  };
  const joined = buildReviewerBwrapArgs(paths, {
    reviewId: "review-123", reviewerAgentDir: "/run/private/reviewer-agent", reviewerWorkspace: "/run/private/reviewer-workspace",
    reviewerSocketDirectory: "/run/private/reviewer", prompt: "review exactly one commit",
  }).join("\n");
  assert.match(joined, /PI_CAD_REVIEW_ID\nreview-123/);
  assert.match(joined, /--ro-bind\n\/run\/private\/reviewer\n\/run\/pi-cad\/reviewer/);
  assert.match(joined, /--autonomous-max-turns\n16/);
  assert.match(joined, /--no-session/);
  assert.doesNotMatch(joined, /\/author-project|\/run\/private\/author|PI_CAD_AUTHOR_SOCKET/);
  assert.doesNotMatch(joined, /--ro-bind\n\/repo\/pi-cad\n/);
});
