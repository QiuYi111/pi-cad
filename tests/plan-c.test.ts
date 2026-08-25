import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { compilePhaseCard } from "../src/harness/card.ts";
import { canonicalJson } from "../src/harness/canonical.ts";
import { commitWorkspace, loadWorkspaceCommit, workspaceHistory } from "../src/harness/commit.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import primeExtension from "../src/integrations/prime/extension.ts";
import { PHASE_CARD_CUSTOM_TYPE } from "../src/integrations/prime/phase-card-message.ts";
import { handleAgentApi } from "../src/agent-api/handlers.ts";
import probeExtension from "../src/extensions/probe/index.ts";
import { startAuthoritySidecar } from "../src/authority/sidecar.ts";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function workflow() {
  return compileWorkflowDefinition({
    schema: 1, id: "test/plan-c", version: "1.0.0", parametersSchema: {}, initialPhase: "design",
    phases: {
      design: {
        purpose: "Freeze a generic design handoff", guidance: "Use Python for bulk work.\nCommit only stable values.",
        recommendedTemplates: ["mechanical.part-work"], recommendedSkills: ["mechanical.interface-check"],
        actions: ["cad_commit", "cad_build_step", "transition"], grants: ["model_build", "observe", "transition"], writeScopes: ["run:state"],
        recordObligations: [{ ref: "system-design", type: "workspace_commit", closeWith: "cad_commit" }],
        evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [],
        transitions: { integrated: { target: "review", requiresPhaseObligations: true } },
      },
      review: {
        purpose: "Review the committed handoff", actions: ["read"], grants: ["file_read"], writeScopes: [],
        recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
      },
    },
  }, mechanicalRegistries);
}

async function projectFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-"));
  const project = new HarnessProjectStoreV7(cwd);
  const loaded = await project.startRun({ workflow: workflow(), registryContract: buildRegistryContract(mechanicalRegistries) });
  return { cwd, loaded };
}

test("Plan C discovers and pins a workflow package before mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-start-"));
  try {
    assert.equal(await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }), null);
    await assert.rejects(
      handleAgentApi(cwd, { schema: 1, op: "model-build", source: "part.py", output: "build/part.step" }),
      /cad\.workflow\.start/,
    );
    const packages = await handleAgentApi(cwd, { schema: 1, op: "workflow-list" }) as any[];
    assert.deepEqual(packages.map((item) => item.id), ["mechanical.analysis", "mechanical.modify", "mechanical.one-shot"]);
    assert.deepEqual(Object.keys(packages[0]).sort(), ["description", "id", "tags", "version"]);
    const started = await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" }) as any;
    assert.equal(started.workflowId, "mechanical.one-shot");
    assert.equal(started.phase, "grill");
    assert.deepEqual(started.unmet, ["grill"]);
    await assert.rejects(
      handleAgentApi(cwd, { schema: 1, op: "model-build", source: "part.py", output: "build/part.step" }),
      /model\.build is not granted in workflow phase grill/,
    );
    const grillCommit = await handleAgentApi(cwd, { schema: 1, op: "commit", name: "grill" }) as any;
    assert.equal(grillCommit.name, "grill");
    assert.deepEqual((await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any).unmet, []);
    const advanced = await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "clarified" }) as any;
    assert.equal(advanced.phase, "spec");
    assert.match((await compilePhaseCard(cwd))?.text ?? "", /SPEC/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Plan C workflow metadata is optional, hashed, and rendered as a bounded stable Phase Card", async () => {
  const { cwd, loaded } = await projectFixture();
  try {
    const first = await compilePhaseCard(cwd);
    assert.ok(first);
    assert.match(first.text, /DESIGN — Freeze a generic design handoff/);
    assert.match(first.text, /Use Python for bulk work/);
    assert.match(first.text, /commit\/evidence: system-design/);
    assert.match(first.text, /template: mechanical.part-work/);
    assert.ok(first.metrics.bytesEmitted <= 6 * 1024);
    assert.deepEqual((await compilePhaseCard(cwd))?.digest, first.digest);
    const durations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await compilePhaseCard(cwd);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    assert.ok(durations[18]! < 250, `warm Phase Card p95 exceeded 250ms: ${durations.join(",")}`);

    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(join(cwd, "mandatory.png"), image);
    const store = new HarnessRunStoreV7(cwd, loaded.state.runId);
    await store.mutate(mechanicalRegistries, (current) => ({
      state: { ...current.state, contextRefs: { mandatoryImageIso: "mandatory.png" } },
      event: { type: "MandatoryImageSelected" },
    }));
    const withImage = await compilePhaseCard(cwd);
    assert.equal(withImage?.images.length, 1);
    assert.equal(withImage?.images[0]?.sha256, createHash("sha256").update(image).digest("hex"));
    const tiny = await compilePhaseCard(cwd, { maxTextBytes: 256 });
    assert.ok(tiny?.metrics.truncated);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Plan C model build reuses the v7 visual chain and pins mandatory Phase Card images", async () => {
  const { cwd, loaded } = await projectFixture();
  try {
    await copyFile(resolve(import.meta.dirname, "fixtures", "plate.py"), join(cwd, "plate.py"));
    const result = await handleAgentApi(cwd, {
      schema: 1, op: "model-build", source: "plate.py", output: "build/plate.step", force: true,
    }) as any;
    assert.equal(result.build.ok, true);
    assert.equal(result.visual.ok, true);
    assert.equal(result.geometry.ok, true);
    assert.deepEqual(result.visual.payload.views.map((view: any) => view.name), ["iso", "front", "back", "left", "right", "top", "bottom"]);
    assert.equal(result.images.length, 7);
    const card = await compilePhaseCard(cwd);
    assert.deepEqual(card?.images.map((image) => image.path), [
      `.pi-cad/runs/${loaded.state.runId}/evidence/visual/plate/iso.png`,
      `.pi-cad/runs/${loaded.state.runId}/evidence/visual/plate/front.png`,
    ]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Python-facing probe bridge stays inside the existing fenced programmable backend", async () => {
  probeExtension({ registerTool() {} } as any);
  const { cwd, loaded } = await projectFixture();
  try {
    const artifact = "current.step";
    await copyFile(resolve(import.meta.dirname, "fixtures", "section_box.step"), join(cwd, artifact));
    const content = await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, artifact)));
    const store = new HarnessRunStoreV7(cwd, loaded.state.runId);
    await store.mutate(mechanicalRegistries, (current) => ({
      state: { ...current.state, artifacts: { current: { id: "current", path: artifact, sha256: createHash("sha256").update(content).digest("hex"), role: "candidate" } } },
      event: { type: "FixtureArtifactBound" },
    }));
    const result = await handleAgentApi(cwd, { schema: 1, op: "probe", subject: "current", purpose: "count solids", code: "result = {'solids': len(shape.solids())}" });
    assert.equal((result as any).value.solids, 1);
    assert.match((result as any).artifactHash, /^[a-f0-9]{64}$/);
    assert.match((result as any).scriptHash, /^[a-f0-9]{64}$/);

    const detached = "detached.step";
    await copyFile(resolve(import.meta.dirname, "fixtures", "section_box.step"), join(cwd, detached));
    const detachedBytes = await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, detached)));
    const detachedHash = createHash("sha256").update(detachedBytes).digest("hex");
    const direct = await handleAgentApi(cwd, {
      schema: 1, op: "probe",
      subject: { kind: "artifact", path: detached, sha256: detachedHash, role: "candidate" },
      purpose: "probe an unbound ArtifactRef",
      code: "result = {'solids': len(shape.solids())}",
    });
    assert.equal((direct as any).value.solids, 1);
    assert.equal((direct as any).artifactHash, detachedHash);

    await assert.rejects(
      handleAgentApi(cwd, {
        schema: 1, op: "probe",
        subject: { kind: "artifact", path: detached, sha256: "0".repeat(64) },
        purpose: "reject stale ref", code: "result = 1",
      }),
      /ArtifactRef hash mismatch/,
    );
    await assert.rejects(
      handleAgentApi(cwd, {
        schema: 1, op: "probe",
        subject: { kind: "artifact", path: resolve(import.meta.dirname, "fixtures", "section_box.step") },
        purpose: "reject escape", code: "result = 1",
      }),
      /escapes the project root/,
    );
    await assert.rejects(
      handleAgentApi(cwd, { schema: 1, op: "probe", subject: "current", purpose: "blocked filesystem", code: "result = open('/tmp/nope')" }),
      /NameError|failed/i,
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("generic workspace commits hash variables and artifacts, chain parents, load cross-process, and close workflow expectations", async () => {
  const { cwd, loaded } = await projectFixture();
  try {
    await writeFile(join(cwd, "part.step"), "first");
    const encodedBody = { codec: "json", value: { width: 20, tags: ["stable"] } };
    const pythonFloatBody = { codec: "json", value: { bottom: 0 } };
    const pythonSpellingHash = createHash("sha256").update('{"codec":"json","value":{"bottom":0.0}}').digest("hex");
    const first = await commitWorkspace({
      cwd, registries: mechanicalRegistries, name: "system-design",
      variables: {
        project: { ...encodedBody, sha256: sha256(encodedBody) },
        placement: { ...pythonFloatBody, sha256: pythonSpellingHash },
      },
      artifacts: ["part.step"],
    });
    assert.equal(first.parent, null);
    assert.match(first.id, /^commit-[a-f0-9]{32}$/);
    assert.equal((await new HarnessRunStoreV7(cwd, loaded.state.runId).load(mechanicalRegistries))?.state.records["system-design"]?.type, "workspace_commit");
    const restored = await loadWorkspaceCommit(cwd, mechanicalRegistries, first.id);
    assert.deepEqual((restored.variables.project as any).value, encodedBody.value);
    assert.deepEqual((restored.variables.placement as any).value, { bottom: 0 });
    assert.equal(first.variables.placement?.sha256, sha256(pythonFloatBody));

    await writeFile(join(cwd, "part.step"), "second");
    const second = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "part-v2", artifacts: ["part.step"] });
    assert.equal(second.parent, first.id);
    assert.notEqual(second.artifacts[0]?.sha256, first.artifacts[0]?.sha256);
    assert.deepEqual((await workspaceHistory(cwd, mechanicalRegistries)).map((item) => item.id), [first.id, second.id]);

    const sibling = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "parallel-delivery", parent: first.id });
    assert.equal(sibling.parent, first.id);
    await assert.rejects(
      commitWorkspace({ cwd, registries: mechanicalRegistries, name: "orphan", parent: `commit-${"0".repeat(32)}` }),
      /parent not found/,
    );

    const repo = resolve(import.meta.dirname, "..");
    const python = spawnSync("uv", ["run", "--offline", "--frozen", "--project", join(repo, "python"), "python", "-c",
      `import asyncio, cad; c=asyncio.run(cad.load(${JSON.stringify(first.id)})); print(c.id, c.variables["project"]["width"])`],
      { cwd, encoding: "utf-8", env: { ...process.env, PI_CAD_REPO: repo, PI_CAD_PROJECT_CWD: cwd } });
    assert.equal(python.status, 0, python.stderr);
    assert.match(python.stdout, new RegExp(`${first.id} 20`));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Python cad.commit crosses the real bridge with float snapshots and project-local absolute paths", async () => {
  const { cwd } = await projectFixture();
  try {
    await writeFile(join(cwd, "part.step"), "STEP");
    await writeFile(join(cwd, "source.py"), "result = None\n");
    const repo = resolve(import.meta.dirname, "..");
    const code = [
      "import asyncio",
      "from pathlib import Path",
      "import cad",
      `root = Path(${JSON.stringify(cwd)})`,
      "artifact = cad.ArtifactRef(Path('part.step'), role='candidate')",
      "commit = asyncio.run(cad.commit('system-design', variables={'placement': {'bottom': 0.0, 'top': -0.0}}, artifacts=[artifact, root / 'source.py']))",
      "print(commit.id)",
    ].join("; ");
    const python = spawnSync("uv", ["run", "--offline", "--frozen", "--project", join(repo, "python"), "python", "-c", code], {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: join(repo, "skills", "cad", "src"),
        PI_CAD_REPO: repo,
        PI_CAD_PROJECT_CWD: cwd,
      },
    });
    assert.equal(python.status, 0, python.stderr);
    const id = python.stdout.trim();
    assert.match(id, /^commit-[a-f0-9]{32}$/);
    const restored = await loadWorkspaceCommit(cwd, mechanicalRegistries, id);
    assert.deepEqual((restored.variables.placement as any).value, { bottom: 0, top: 0 });
    assert.deepEqual(restored.manifest.artifacts.map((item) => item.path), ["part.step", "source.py"]);
    assert.deepEqual((await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any).unmet, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("thin Prime extension injects exactly one ephemeral current card and is silent without a run", async () => {
  const { cwd } = await projectFixture();
  const runtime = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-test-"));
  const previousSocket = process.env.PI_CAD_AUTHOR_SOCKET;
  const sidecar = await startAuthoritySidecar({ cwd, runtimeDirectory: runtime });
  process.env.PI_CAD_AUTHOR_SOCKET = sidecar.authorSocket;
  const handlers = new Map<string, Function>();
  const pi = { on(name: string, handler: Function) { handlers.set(name, handler); } } as any;
  primeExtension(pi);
  const context = handlers.get("context")!;
  const toolCall = handlers.get("tool_call")!;
  const original = [{ role: "user", content: "hello", timestamp: 1 }];
  const first = await context({ messages: original }, { cwd });
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[1].customType, PHASE_CARD_CUSTOM_TYPE);
  assert.equal(first.messages[1].display, false);
  const second = await context({ messages: [...original, first.messages[1]] }, { cwd });
  assert.equal(second.messages.filter((item: any) => item.customType === PHASE_CARD_CUSTOM_TYPE).length, 1);
  const deniedImage = await toolCall({ toolName: "codex_generate_image", input: { prompt: "concept" } }, { cwd });
  assert.equal(deniedImage.block, true);
  assert.match(deniedImage.reason, /image\.generate is not granted in workflow phase design/);

  await sidecar.close();
  const unavailableImage = await toolCall({ toolName: "codex_generate_image", input: { prompt: "concept" } }, { cwd });
  assert.equal(unavailableImage.block, true);
  assert.match(unavailableImage.reason, /authority sidecar unavailable/i);
  const empty = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-empty-"));
  const emptyRuntime = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-empty-"));
  const emptySidecar = await startAuthoritySidecar({ cwd: empty, runtimeDirectory: emptyRuntime });
  process.env.PI_CAD_AUTHOR_SOCKET = emptySidecar.authorSocket;
  try {
    assert.equal(await context({ messages: original }, { cwd: empty }), undefined);
    assert.equal(await toolCall({ toolName: "codex_generate_image", input: { prompt: "ordinary image" } }, { cwd: empty }), undefined);
  }
  finally {
    await emptySidecar.close();
    if (previousSocket === undefined) delete process.env.PI_CAD_AUTHOR_SOCKET;
    else process.env.PI_CAD_AUTHOR_SOCKET = previousSocket;
    await rm(empty, { recursive: true, force: true });
    await rm(emptyRuntime, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
  await rm(cwd, { recursive: true, force: true });
});
