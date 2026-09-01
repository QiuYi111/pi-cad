import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
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
import { requestAuthority } from "../src/integrations/prime/sidecar-client.ts";
import { handleAgentApi } from "../src/agent-api/handlers.ts";
import probeExtension from "../src/extensions/probe/index.ts";
import { startAuthoritySidecar } from "../src/authority/sidecar.ts";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cardSection(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing Phase Card section ${heading}`);
  const end = lines.findIndex((line, index) => index > start && ["WHERE", "GOAL", "SOP", "MUST", "CAN", "NEXT", "STATE", "WARNINGS"].includes(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
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
        purpose: "Review the committed handoff", actions: ["read", "transition"], grants: ["file_read", "transition"], writeScopes: [],
        recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { completed: { target: "done" } },
      },
      done: {
        purpose: "Preserve the terminal handoff", actions: [], grants: ["file_read"], writeScopes: [],
        recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
      },
    },
  }, mechanicalRegistries);
}

test("authority client retries bounded transient socket closures", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "pi-cad-authority-retry-"));
  const socketPath = join(runtime, "authority.sock");
  const previousSocket = process.env.PI_CAD_AUTHOR_SOCKET;
  let attempts = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => undefined);
    socket.on("data", () => undefined);
    socket.on("end", () => {
      attempts++;
      if (attempts < 3) socket.destroy();
      else socket.end(`${JSON.stringify({ schema: 1, ok: true, result: { live: true } })}\n`);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolveListen);
  });
  process.env.PI_CAD_AUTHOR_SOCKET = socketPath;
  try {
    assert.deepEqual(
      await requestAuthority({ op: "phase-card" }, { retries: 2, retryDelayMs: 1, timeoutMs: 1000 }),
      { live: true },
    );
    assert.equal(attempts, 3);
  } finally {
    if (previousSocket === undefined) delete process.env.PI_CAD_AUTHOR_SOCKET;
    else process.env.PI_CAD_AUTHOR_SOCKET = previousSocket;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(runtime, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(packages.map((item) => item.id), [
      "mechanical.analysis",
      "mechanical.benchmark",
      "mechanical.benchmark-author-only",
      "mechanical.benchmark-build",
      "mechanical.benchmark-triage",
      "mechanical.modify",
      "mechanical.one-shot",
    ]);
    assert.deepEqual(Object.keys(packages[0]).sort(), ["description", "id", "tags", "version"]);
    const started = await handleAgentApi(cwd, { schema: 1, op: "workflow-start", id: "mechanical.one-shot" }) as any;
    assert.equal(started.workflowId, "mechanical.one-shot");
    assert.equal(started.phase, "grilling");
    assert.deepEqual(started.unmet, ["grill"]);
    await assert.rejects(
      handleAgentApi(cwd, { schema: 1, op: "model-build", source: "part.py", output: "build/part.step" }),
      /model\.build is not granted in workflow phase grilling/,
    );
    const grillCommit = await handleAgentApi(cwd, { schema: 1, op: "commit", name: "grill" }) as any;
    assert.equal(grillCommit.name, "grill");
    assert.deepEqual((await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any).unmet, []);
    const advanced = await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "clarified" }) as any;
    assert.equal(advanced.phase, "spec");
    assert.match((await compilePhaseCard(cwd, { registries: mechanicalRegistries }))?.text ?? "", /phase spec/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Plan C workflow metadata is optional, hashed, and rendered as a bounded stable Phase Card", async () => {
  const { cwd, loaded } = await projectFixture();
  try {
    const first = await compilePhaseCard(cwd, { registries: mechanicalRegistries });
    assert.ok(first);
    const headings = first.text.split("\n").filter((line) => ["WHERE", "GOAL", "SOP", "MUST", "CAN", "NEXT", "STATE", "WARNINGS"].includes(line));
    assert.deepEqual(headings, ["WHERE", "GOAL", "SOP", "MUST", "CAN", "NEXT", "STATE", "WARNINGS"]);
    assert.match(first.text, /phase design/);
    assert.match(first.text, /Freeze a generic design handoff/);
    assert.match(first.text, /Use Python for bulk work/);
    assert.deepEqual(first.unmetObligations, ["system-design"]);
    assert.deepEqual(first.legalTransitions, []);
    assert.ok(first.effectiveCapabilities.includes("cad_build_step"));
    assert.deepEqual(cardSection(first.text, "MUST").map((line) => line.split(" (")[0]), first.unmetObligations);
    assert.deepEqual(cardSection(first.text, "CAN").map((line) => line.split(" — ")[0]), first.effectiveCapabilities);
    assert.deepEqual(cardSection(first.text, "NEXT"), first.legalTransitions);
    assert.match(cardSection(first.text, "MUST")[0] ?? "", /close with await cad\.commit\("system-design"/);
    assert.ok(cardSection(first.text, "CAN").some((line) => /cad_build_step — artifact = await cad\.model\.build\(source, output, force=True\)/.test(line)));
    const current = await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any;
    assert.equal(current.text, first.text);
    assert.deepEqual(current.must, cardSection(first.text, "MUST"));
    assert.deepEqual(current.can, cardSection(first.text, "CAN"));
    assert.deepEqual(current.next, cardSection(first.text, "NEXT"));
    assert.deepEqual(current.obligations, [{
      ref: "system-design", type: "workspace_commit", closeWith: "cad_commit",
      canonicalCall: 'await cad.commit("system-design", variables={...}, artifacts=[...])',
    }]);
    assert.ok(first.metrics.estimatedTokens >= 300 && first.metrics.estimatedTokens <= 800, `unexpected Phase Card token estimate: ${first.metrics.estimatedTokens}`);
    assert.ok(first.metrics.bytesEmitted <= 3200);
    const aggressivelyBounded = await compilePhaseCard(cwd, { registries: mechanicalRegistries, maxTextBytes: 1200 });
    assert.ok(aggressivelyBounded, "an oversized explanatory section must not suppress the authoritative card");
    assert.equal(aggressivelyBounded.metrics.truncated, true);
    assert.deepEqual(cardSection(aggressivelyBounded.text, "MUST").map((line) => line.split(" (")[0]), first.unmetObligations);
    assert.deepEqual(cardSection(aggressivelyBounded.text, "CAN").map((line) => line.split(" — ")[0]), first.effectiveCapabilities);
    assert.deepEqual(cardSection(aggressivelyBounded.text, "NEXT"), first.legalTransitions);
    assert.deepEqual((await compilePhaseCard(cwd, { registries: mechanicalRegistries }))?.digest, first.digest);
    const durations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await compilePhaseCard(cwd, { registries: mechanicalRegistries });
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
    const withImage = await compilePhaseCard(cwd, { registries: mechanicalRegistries });
    assert.equal(withImage?.images.length, 1);
    assert.equal(withImage?.images[0]?.sha256, createHash("sha256").update(image).digest("hex"));
    await assert.rejects(
      compilePhaseCard(cwd, { registries: mechanicalRegistries, maxTextBytes: 1199 }),
      /at least 1200 bytes/,
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Plan C model build reuses the v7 visual chain and pins mandatory Phase Card images", async () => {
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-canonical-"));
  const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
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
    assert.ok(result.images.every((image: any) => image.mimeType === "image/png" && Buffer.from(image.data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))));
    assert.deepEqual(result.images.map((image: any) => image.name), ["iso", "front", "back", "left", "right", "top", "bottom"]);
    const afterBuild = await new HarnessRunStoreV7(cwd, loaded.state.runId).load(mechanicalRegistries);
    assert.equal(afterBuild?.state.artifacts["candidate:authoritative"]?.path, "build/plate.step");
    assert.equal(afterBuild?.state.artifacts["candidate:source"]?.path, "plate.py");
    assert.equal(afterBuild?.state.artifacts["candidate:source"]?.sha256, createHash("sha256").update(await readFile(join(cwd, "plate.py"))).digest("hex"));
    const card = await compilePhaseCard(cwd, { registries: mechanicalRegistries });
    assert.deepEqual(card?.images.map((image) => image.path), [
      `@canonical/runs/${loaded.state.runId}/evidence/visual/plate/iso.png`,
      `@canonical/runs/${loaded.state.runId}/evidence/visual/plate/front.png`,
    ]);
  } finally {
    if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
  }
});

test("a managed rebuild revises build evidence and exposes the transition only after success", async () => {
  const canonical = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-rebuild-canonical-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-rebuild-"));
  const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  try {
    const rebuildWorkflow = compileWorkflowDefinition({
      schema: 1, id: "test/rebuild", version: "1.0.0", parametersSchema: {}, initialPhase: "build",
      phases: {
        build: {
          purpose: "Build and revise a candidate", actions: ["cad_build_step", "transition"], grants: ["model_build", "observe", "transition"],
          writeScopes: ["project:deliverable"], recordObligations: [],
          evidenceObligations: [
            { ref: "candidate-visual", type: "visual", closeWith: "cad_build_step" },
            { ref: "candidate-geometry", type: "geometry", closeWith: "cad_build_step" },
          ], contextProviders: ["kernel.current-action"], hooks: [],
          transitions: { built: { target: "done", requiresPhaseObligations: true } },
        },
        done: { purpose: "Done", actions: [], grants: [], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
      },
    }, mechanicalRegistries);
    const started = await new HarnessProjectStoreV7(cwd).startRun({ workflow: rebuildWorkflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    const sourcePath = join(cwd, "plate.py");
    await copyFile(resolve(import.meta.dirname, "fixtures", "plate.py"), sourcePath);
    assert.deepEqual((await compilePhaseCard(cwd, { registries: mechanicalRegistries }))?.legalTransitions, []);
    await handleAgentApi(cwd, { schema: 1, op: "model-build", source: "plate.py", output: "build/plate.step", force: true });
    const catalog = await handleAgentApi(cwd, { schema: 1, op: "viewer-catalog" }) as any;
    assert.equal(catalog.currentRun.id, started.state.runId);
    assert.equal(catalog.currentRun.artifacts.find((item: any) => item.id === "candidate:authoritative")?.path, "build/plate.step");
    const first = await new HarnessRunStoreV7(cwd, started.state.runId).load(mechanicalRegistries);
    assert.ok(first);
    assert.equal(first.state.evidence.length, 2);
    assert.deepEqual((await compilePhaseCard(cwd, { registries: mechanicalRegistries }))?.legalTransitions, ["built -> done"]);
    await writeFile(sourcePath, (await readFile(sourcePath, "utf-8")).replace("Box(100, 80, 5)", "Box(110, 80, 5)"));
    await handleAgentApi(cwd, { schema: 1, op: "model-build", source: "plate.py", output: "build/plate.step", force: true });
    const second = await new HarnessRunStoreV7(cwd, started.state.runId).load(mechanicalRegistries);
    assert.ok(second);
    assert.equal(second.state.evidence.length, 2);
    assert.equal(second.state.staleEvidence.length, 2);
    assert.notDeepEqual(second.state.evidence.map((item) => item.sha256), first.state.evidence.map((item) => item.sha256));
    assert.deepEqual((await compilePhaseCard(cwd, { registries: mechanicalRegistries }))?.legalTransitions, ["built -> done"]);
  } finally {
    if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
    await rm(cwd, { recursive: true, force: true });
    await rm(canonical, { recursive: true, force: true });
  }
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
      "child = asyncio.run(cad.commit('review-candidate', artifacts=[artifact, root / 'source.py']))",
      "print(commit.id, child.id)",
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
    const [id, childId] = python.stdout.trim().split(/\s+/);
    assert.match(id!, /^commit-[a-f0-9]{32}$/);
    assert.match(childId!, /^commit-[a-f0-9]{32}$/);
    const restored = await loadWorkspaceCommit(cwd, mechanicalRegistries, id!);
    assert.deepEqual((restored.variables.placement as any).value, { bottom: 0, top: 0 });
    assert.deepEqual(restored.manifest.artifacts.map((item) => item.path), ["part.step", "source.py"]);
    const child = await loadWorkspaceCommit(cwd, mechanicalRegistries, childId!);
    assert.equal(child.manifest.parent, id);
    assert.deepEqual((await handleAgentApi(cwd, { schema: 1, op: "workflow-current" }) as any).unmet, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("thin Prime extension injects exactly one ephemeral current card and is silent without a run", async () => {
  const { cwd } = await projectFixture();
  const runtime = await mkdtemp(join(tmpdir(), "pi-cad-sidecar-test-"));
  const previousSocket = process.env.PI_CAD_AUTHOR_SOCKET;
  let reportedModel: unknown;
  const sidecar = await startAuthoritySidecar({ cwd, runtimeDirectory: runtime, onAuthorModelSelection: (selection) => { reportedModel = selection; } });
  process.env.PI_CAD_AUTHOR_SOCKET = sidecar.authorSocket;
  const handlers = new Map<string, Function>();
  const registeredTools = new Map<string, unknown>();
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: { name: string }) { registeredTools.set(tool.name, tool); },
    getThinkingLevel() { return "low"; },
  } as any;
  primeExtension(pi);
  assert.deepEqual([...registeredTools.keys()].sort(), [
    "cad_experience_find", "cad_experience_get", "cad_experience_read", "cad_experience_search",
  ]);
  const context = handlers.get("context")!;
  const toolCall = handlers.get("tool_call")!;
  const original = [{ role: "user", content: "hello", timestamp: 1 }];
  const first = await context({ messages: original }, { cwd, model: { provider: "dashscope", id: "qwen3.8-max" } });
  assert.deepEqual(reportedModel, { provider: "dashscope", model: "qwen3.8-max", thinking: "low" });
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[1].customType, PHASE_CARD_CUSTOM_TYPE);
  assert.equal(first.messages[1].display, false);
  const activeAfterContext = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  assert.ok(activeAfterContext);
  const frame = await new HarnessRunStoreV7(cwd, activeAfterContext.state.runId).transactions.readJson<any>("context/frame.json");
  assert.equal(frame?.mission, "hello");
  await handleAgentApi(cwd, { schema: 1, op: "commit", name: "system-design" });
  await handleAgentApi(cwd, { schema: 1, op: "workflow-advance", event: "integrated" });
  const second = await context({ messages: [...original, first.messages[1]] }, { cwd });
  assert.equal(second.messages.filter((item: any) => item.customType === PHASE_CARD_CUSTOM_TYPE).length, 1);
  assert.match(second.messages.at(-1).content[0].text, /phase review/);
  assert.doesNotMatch(second.messages.at(-1).content[0].text, /phase design/);
  const deniedImage = await toolCall({ toolName: "codex_generate_image", input: { prompt: "concept" } }, { cwd });
  assert.equal(deniedImage.block, true);
  assert.match(deniedImage.reason, /image\.generate is not granted in workflow phase review/);

  await sidecar.close();
  const unavailableContext = await context({ messages: original }, { cwd, model: { provider: "dashscope", id: "qwen3.8-max" } });
  const fallbackCard = unavailableContext.messages.at(-1).content;
  assert.match(fallbackCard, /await cad\.workflow\.current\(\)/);
  assert.match(fallbackCard, /read only/);
  assert.doesNotMatch(fallbackCard, /CAN\n- none/);
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
