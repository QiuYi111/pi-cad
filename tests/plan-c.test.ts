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
        actions: ["cad_commit", "transition"], grants: ["transition"], writeScopes: ["run:state"],
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
    const first = await commitWorkspace({
      cwd, registries: mechanicalRegistries, name: "system-design",
      variables: { project: { ...encodedBody, sha256: sha256(encodedBody) } }, artifacts: ["part.step"],
    });
    assert.equal(first.parent, null);
    assert.match(first.id, /^commit-[a-f0-9]{32}$/);
    assert.equal((await new HarnessRunStoreV7(cwd, loaded.state.runId).load(mechanicalRegistries))?.state.records["system-design"]?.type, "workspace_commit");
    const restored = await loadWorkspaceCommit(cwd, mechanicalRegistries, first.id);
    assert.deepEqual((restored.variables.project as any).value, encodedBody.value);

    await writeFile(join(cwd, "part.step"), "second");
    const second = await commitWorkspace({ cwd, registries: mechanicalRegistries, name: "part-v2", artifacts: ["part.step"] });
    assert.equal(second.parent, first.id);
    assert.notEqual(second.artifacts[0]?.sha256, first.artifacts[0]?.sha256);
    assert.deepEqual((await workspaceHistory(cwd, mechanicalRegistries)).map((item) => item.id), [first.id, second.id]);

    const repo = resolve(import.meta.dirname, "..");
    const python = spawnSync("uv", ["run", "--offline", "--frozen", "--project", join(repo, "python"), "python", "-c",
      `import asyncio, cad; c=asyncio.run(cad.load(${JSON.stringify(first.id)})); print(c.id, c.variables["project"]["width"])`],
      { cwd, encoding: "utf-8", env: { ...process.env, PI_CAD_REPO: repo, PI_CAD_PROJECT_CWD: cwd } });
    assert.equal(python.status, 0, python.stderr);
    assert.match(python.stdout, new RegExp(`${first.id} 20`));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("thin Prime extension injects exactly one ephemeral current card and is silent without a run", async () => {
  const { cwd } = await projectFixture();
  const handlers = new Map<string, Function>();
  const pi = { on(name: string, handler: Function) { handlers.set(name, handler); } } as any;
  primeExtension(pi);
  const context = handlers.get("context")!;
  const original = [{ role: "user", content: "hello", timestamp: 1 }];
  const first = await context({ messages: original }, { cwd });
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[1].customType, PHASE_CARD_CUSTOM_TYPE);
  assert.equal(first.messages[1].display, false);
  const second = await context({ messages: [...original, first.messages[1]] }, { cwd });
  assert.equal(second.messages.filter((item: any) => item.customType === PHASE_CARD_CUSTOM_TYPE).length, 1);

  const empty = await mkdtemp(join(tmpdir(), "pi-cad-plan-c-empty-"));
  try { assert.equal(await context({ messages: original }, { cwd: empty }), undefined); }
  finally { await rm(empty, { recursive: true, force: true }); }
  await rm(cwd, { recursive: true, force: true });
});
