import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPrimeBwrapArgs, buildReviewerBwrapArgs, resolvePrimeRepository, resolveReviewerLaunchOptions, reviewerModelArgs, withHeadlessEventContinuation, type LaunchPaths } from "../src/authority/launcher.ts";
import { completionGate, dispatchSidecarRequest, startAuthoritySidecar } from "../src/authority/sidecar.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { commitWorkspace } from "../src/harness/commit.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("Prime repository resolution persists custom setup paths and fails with an actionable error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-prime-path-"));
  const repository = join(root, "pi-cad");
  const agentDirectory = join(root, "agent");
  const primeRepository = join(root, "custom-prime");
  try {
    await mkdir(repository);
    await mkdir(agentDirectory);
    await mkdir(primeRepository);
    await writeFile(join(primeRepository, "prime-agent.sh"), "#!/usr/bin/env bash\n");
    await writeFile(join(agentDirectory, "prime-cad.json"), `${JSON.stringify({ primeAgentRepo: primeRepository })}\n`);
    assert.equal(resolvePrimeRepository(repository, agentDirectory, undefined), primeRepository);
    assert.equal(resolvePrimeRepository(repository, agentDirectory, primeRepository), primeRepository);
    await writeFile(join(agentDirectory, "prime-cad.json"), `${JSON.stringify({ primeAgentRepo: join(root, "missing") })}\n`);
    assert.throws(() => resolvePrimeRepository(repository, agentDirectory, undefined), /Run npm run prime:setup with PRIME_AGENT_REPO=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewer model defaults to the live author model and supports fixed config plus CLI overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-reviewer-model-"));
  try {
    const inherited = resolveReviewerLaunchOptions(["--model", "author-model"], root, {});
    assert.deepEqual(inherited.primeArgs, ["--model", "author-model"]);
    assert.deepEqual(inherited.policy, { mode: "inherit" });
    assert.deepEqual(reviewerModelArgs(inherited.policy, { provider: "dashscope", model: "qwen3.8-max", thinking: "low" }), [
      "--provider", "dashscope", "--model", "qwen3.8-max", "--thinking", "low",
    ]);
    assert.deepEqual(reviewerModelArgs(inherited.policy, { provider: "faux", model: "faux", thinking: "off" }), [
      "--provider", "faux", "--model", "faux", "--thinking", "off",
    ]);

    await writeFile(join(root, "prime-cad.json"), `${JSON.stringify({ reviewer: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" } })}\n`);
    const configured = resolveReviewerLaunchOptions([], root, {});
    assert.deepEqual(reviewerModelArgs(configured.policy, { provider: "dashscope", model: "qwen3.8-max", thinking: "low" }), [
      "--provider", "openai-codex", "--model", "gpt-5.6-luna", "--thinking", "high",
    ]);

    const overridden = resolveReviewerLaunchOptions([
      "--reviewer-provider", "openrouter", "--reviewer-model=review-model", "--reviewer-thinking", "xhigh", "--print", "work",
    ], root, {});
    assert.deepEqual(overridden.primeArgs, ["--print", "work"]);
    assert.deepEqual(reviewerModelArgs(overridden.policy, undefined), [
      "--provider", "openrouter", "--model", "review-model", "--thinking", "xhigh",
    ]);

    const inheritOverride = resolveReviewerLaunchOptions(["--reviewer-inherit-author", "--reviewer-thinking", "medium"], root, {});
    assert.deepEqual(reviewerModelArgs(inheritOverride.policy, { provider: "dashscope", model: "qwen3.8-max", thinking: "low" }), [
      "--provider", "dashscope", "--model", "qwen3.8-max", "--thinking", "medium",
    ]);
    assert.deepEqual(resolveReviewerLaunchOptions(["--", "mention", "--reviewer-model", "as text"], root, {}).primeArgs, ["--", "mention", "--reviewer-model", "as text"]);
    assert.throws(() => resolveReviewerLaunchOptions(["--reviewer-model", "orphan"], root, {}), /must be provided together/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.equal(projection.run.phase, "grilling");
    assert.equal(projection.run.workflowId, "mechanical.one-shot");
    assert.ok(projection.run.workflowHash);
    assert.deepEqual(projection.run.phaseHistory, ["grilling"]);
    assert.equal(projection.run.phases.find((phase: any) => phase.id === "grilling").status, "active");
    assert.deepEqual(projection.run.phases.find((phase: any) => phase.id === "grilling").transitions, []);
    assert.ok(projection.run.phases.some((phase: any) => phase.id !== "grilling" && phase.transitions.length > 0));
    assert.ok(projection.run.phases.find((phase: any) => phase.id === "grilling").capabilities.length > 0);

    await chmod(statusPath, 0o644);
    await writeFile(statusPath, '{"authoritative":true,"run":{"phase":"release"}}\n');
    const current = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-current" });
    assert.equal(current.ok, true);
    assert.equal((current.result as any).phase, "grilling");
    assert.equal(JSON.parse(await readFile(statusPath, "utf-8")).authoritative, false);

    const gate = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "completion-gate" });
    assert.equal(gate.ok, true);
    assert.equal((gate.result as any).complete, false);
    const reviewerGate = await dispatchSidecarRequest("reviewer", cwd, { schema: 1, op: "completion-gate" });
    assert.equal(reviewerGate.ok, false);

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
          recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.final-review", transitions: {}, terminal: true,
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

test("completion gate permits a workflow with only pre-build review when release contains the current candidate and source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-review-free-gate-"));
  try {
    await writeFile(join(cwd, "part.step"), "authoritative step");
    await writeFile(join(cwd, "part.py"), "result = None\n");
    const workflow = compileWorkflowDefinition({
      schema: 1,
      id: "test/pre-build-review",
      version: "1.0.0",
      parametersSchema: {},
      initialPhase: "requirements_review",
      phases: {
        requirements_review: {
          purpose: "Review interpreted requirements", actions: ["cad_submit_for_review"], grants: ["file_read"], writeScopes: [],
          recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], reviewProfile: "mechanical.requirements-review",
          transitions: { accepted: { target: "build", reviewVerdicts: ["pass"] } },
        },
        build: {
          purpose: "Delivered",
          actions: ["cad_build_step", "cad_commit"],
          grants: ["model_build", "commit_plan"],
          writeScopes: ["project:deliverable", "run:record", "run:state"],
          recordObligations: [{ ref: "release", type: "workspace_commit", closeWith: "cad_commit" }],
          evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
        },
      },
    }, mechanicalRegistries);
    const project = new HarnessProjectStoreV7(cwd);
    const initial = await project.startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    await new HarnessRunStoreV7(cwd, initial.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: {
        ...state,
        phase: "build",
        phaseHistory: ["requirements_review", "build"],
        artifacts: {
          "candidate:authoritative": { id: "candidate:authoritative", path: "part.step", sha256: "a".repeat(64), role: "authoritative-candidate-design" },
          "candidate:source": { id: "candidate:source", path: "part.py", sha256: "b".repeat(64), role: "candidate-source" },
        },
      },
      event: { type: "TestCandidateInstalled" },
    }));
    await commitWorkspace({
      cwd,
      registries: mechanicalRegistries,
      name: "release",
      artifacts: [
        { path: "part.step", role: "authoritative-candidate-design" },
        { path: "part.py", role: "candidate-source" },
      ],
    });
    await new HarnessRunStoreV7(cwd, initial.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, status: "done" },
      event: { type: "TestCompleted" },
    }));
    const mismatched = await completionGate(cwd);
    assert.equal(mismatched.complete, false);
    assert.match(mismatched.reason, /current authoritative candidate and source/);

    const history = await new HarnessRunStoreV7(cwd, initial.state.runId).transactions.readJson<{ commits: string[] }>("workspace/commits/index.json");
    const manifest = await new HarnessRunStoreV7(cwd, initial.state.runId).transactions.readJson<{ artifacts: Array<{ path: string; sha256: string; role: string }> }>(`workspace/commits/${history!.commits[0]}.json`);
    await new HarnessRunStoreV7(cwd, initial.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: {
        ...state,
        artifacts: {
          "candidate:authoritative": { id: "candidate:authoritative", ...manifest!.artifacts[0]! },
          "candidate:source": { id: "candidate:source", ...manifest!.artifacts[1]! },
        },
      },
      event: { type: "TestCandidateHashesAligned" },
    }));
    const accepted = await completionGate(cwd);
    assert.equal(accepted.complete, true);
    assert.match(accepted.reason, /without a final review/);
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
  assert.match(joined, /--skill\n\/opt\/pi-cad\/cad\/SKILL\.md/);
  assert.match(joined, /cad_experience_search,cad_experience_get,cad_experience_find,cad_experience_read/);
  assert.match(joined, /PYTHONPATH\n[^\n]*\/opt\/pi-cad\/cad\/src/);
  assert.doesNotMatch(joined, /cad-skill/);

  const readOnly = buildPrimeBwrapArgs(paths, ["--print", "inspect it"], "read-only").join("\n");
  assert.match(readOnly, /--ro-bind\n\/project\n\/workspace/);
  assert.doesNotMatch(readOnly, /--bind\n\/project\n\/workspace/);
});

test("desktop read-only authority denies workflow and artifact mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-read-only-"));
  try {
    const started = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" }, undefined, undefined, { authorReadOnly: true });
    assert.equal(started.ok, false);
    if (!started.ok) assert.match(started.error.message, /read-only mode denies/);
    const authorization = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "authorize", operation: "model.build" }, undefined, undefined, { authorReadOnly: true });
    assert.equal(authorization.ok, true);
    if (authorization.ok) assert.deepEqual(authorization.result, { allowed: false, reason: "Desktop is in read-only mode.", legalNextActions: ["Switch permission to Workspace."] });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Prime one-shot mode uses the canonical sidecar completion gate", () => {
  const args = withHeadlessEventContinuation(["--provider", "openai-codex", "--print", "build it"]);
  assert.ok(args.includes("--autonomous"));
  assert.deepEqual(args.slice(args.indexOf("--autonomous-gate"), args.indexOf("--autonomous-gate") + 2), [
    "--autonomous-gate", "$PRIME_AGENT_KERNEL_PYTHON -m cad._completion_gate",
  ]);
  assert.equal(args[args.indexOf("--autonomous-gate-retries") + 1], "8");
  const previousRetries = process.env.PI_CAD_AUTONOMOUS_GATE_RETRIES;
  process.env.PI_CAD_AUTONOMOUS_GATE_RETRIES = "3";
  try {
    const configured = withHeadlessEventContinuation(["--print", "build it"]);
    assert.equal(configured[configured.indexOf("--autonomous-gate-retries") + 1], "3");
  } finally {
    if (previousRetries === undefined) delete process.env.PI_CAD_AUTONOMOUS_GATE_RETRIES;
    else process.env.PI_CAD_AUTONOMOUS_GATE_RETRIES = previousRetries;
  }
  const interactive = withHeadlessEventContinuation(["--provider", "openai-codex"]);
  assert.deepEqual(interactive, ["--provider", "openai-codex"]);
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
    reviewerSocketDirectory: "/run/private/reviewer", prompt: "review exactly one commit", modelArgs: ["--provider", "openai-codex", "--model", "gpt-5.6-luna", "--thinking", "medium"],
  }).join("\n");
  assert.match(joined, /PI_CAD_REVIEW_ID\nreview-123/);
  assert.match(joined, /--ro-bind\n\/run\/private\/reviewer\n\/run\/pi-cad\/reviewer/);
  assert.match(joined, /--autonomous-max-continuations\n9007199254740991/);
  assert.match(joined, /--autonomous-max-turns\n9007199254740991/);
  assert.match(joined, /--autonomous-max-tokens\n9007199254740991/);
  assert.match(joined, /--autonomous-timeout-ms\n9007199254740991/);
  assert.doesNotMatch(joined, /115000/);
  assert.match(joined, /--provider\nopenai-codex\n--model\ngpt-5\.6-luna\n--thinking\nmedium/);
  assert.match(joined, /PI_OFFLINE\n1/);
  assert.match(joined, /--no-session/);
  assert.doesNotMatch(joined, /\/author-project|\/run\/private\/author|PI_CAD_AUTHOR_SOCKET/);
  assert.doesNotMatch(joined, /--ro-bind\n\/repo\/pi-cad\n/);
});
