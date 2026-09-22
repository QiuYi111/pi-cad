import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { writeStatusProjection } from "../src/authority/storage.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { canonicalDigest, jsonValue } from "../src/harness/canonical.ts";
import { commitBoundEvidence, commitRecordRef, finishRun, prepareRecipeObligation, transitionRun } from "../src/harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { TransactionStore } from "../src/harness/transaction-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { checkReifyInvariants, reifySystemInvariants } from "../src/chaos/invariants/index.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// A small but real workflow: it drives the same reducer, transaction store and
// project store the product uses, so the checkers read genuine Reify state.
const WALKING_WORKFLOW = {
  schema: 1,
  id: "test/chaos-invariants",
  version: "1.0.0",
  parametersSchema: { type: "object", additionalProperties: false },
  initialPhase: "requirements",
  phases: {
    requirements: {
      purpose: "Commit requirements", actions: ["commit_record", "transition"], grants: ["transition"], writeScopes: ["run:state"],
      recordObligations: [{ ref: "record:requirements", type: "requirements", closeWith: "commit_record" }], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { committed: { target: "part_design" } },
    },
    part_design: { purpose: "Plan", actions: ["transition"], grants: ["transition"], writeScopes: ["run:state"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { planned: { target: "build" } } },
    build: { purpose: "Build", actions: ["transition"], grants: ["transition"], writeScopes: ["run:state"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { built: { target: "review" } } },
    review: {
      purpose: "Review", actions: ["commit_evidence", "transition"], grants: ["simulate", "transition"], writeScopes: ["run:evidence", "run:state"], recordObligations: [],
      evidenceObligations: [{ ref: "simulation:load-case-1", type: "simulation", closeWith: "commit_evidence", recipeKind: "simulation" }], contextProviders: ["kernel.current-action"], hooks: [], transitions: { accepted: { target: "ready" } },
    },
    ready: { purpose: "Finish", actions: ["finish"], grants: ["finish"], writeScopes: ["project:head", "run:state"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: { finished: { target: "done" } } },
    done: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
  },
} as const;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface Fixture {
  cwd: string;
  runId: string;
  promoted: boolean;
  /** Run-store-relative path of the committed evidence payload. */
  evidencePath: string;
}

/** Drive the real kernel to a completed, promoted run with real bytes on disk. */
async function buildLegalProject(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "reify-invariants-"));
  const workflow = compileWorkflowDefinition(WALKING_WORKFLOW, mechanicalRegistries);
  const contract = buildRegistryContract(mechanicalRegistries);
  const project = new HarnessProjectStoreV7(cwd);
  let loaded = await project.startRun({ workflow, registryContract: contract });
  const runId = loaded.state.runId;
  const run = new HarnessRunStoreV7(cwd, runId);

  const requirements = { goal: "invariant fixture", deliverables: ["STEP"] };
  loaded = await run.mutate(mechanicalRegistries, ({ state, workflow: current }) => ({
    state: commitRecordRef(state, current, {
      obligationRef: "record:requirements", type: "requirements", path: "records/requirements.json",
      // Reify identifies a record by the canonical digest of its value.
      sha256: canonicalDigest(requirements), workflowHash: current.hash, createdAt: new Date().toISOString(),
    }),
    event: { type: "RecordCommitted", data: { obligationRef: "record:requirements" } },
    payloads: { "records/requirements.json": requirements },
  }));
  for (const event of ["committed", "planned", "built"]) {
    loaded = await run.mutate(mechanicalRegistries, ({ state, workflow: current }) => ({ state: transitionRun(state, current, event), event: { type: "Transitioned", data: { event } } }));
  }

  const binding = prepareRecipeObligation({ state: loaded.state, workflow, registryContract: contract, obligationRef: "simulation:load-case-1", recipeKind: "simulation" });
  // Candidate evidence is identified by the canonical digest of its envelope
  // and stored as `{ schema, evidence, envelope }`, exactly as the real
  // candidate action writes it.
  const envelope = { schema: 1, tool: "fixture-probe", toolVersion: "1", ok: true, payload: { mass: 12.5, unit: "g" } };
  const evidenceDigest = canonicalDigest(envelope);
  const evidence = {
    id: `evidence-simulation-${evidenceDigest.slice(0, 20)}`,
    obligationRef: binding.obligationRef, type: "simulation", path: `evidence/simulation/evidence-simulation-${evidenceDigest.slice(0, 20)}.json`,
    sha256: evidenceDigest, workflowHash: workflow.hash, registryContractHash: contract.hash,
    computeIdentity: "c".repeat(64), createdAt: new Date().toISOString(),
  };
  loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({
    state: commitBoundEvidence({
      state, workflow, registryContract: contract, binding, evidence,
    }),
    event: { type: "EvidenceCommitted", data: { obligationRef: binding.obligationRef } },
    payloads: { [evidence.path]: { schema: 1, evidence, envelope } },
  }));
  loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({ state: transitionRun(state, workflow, "accepted"), event: { type: "Transitioned", data: { event: "accepted" } } }));
  loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({ state: finishRun(state, workflow), event: { type: "RunFinished" } }));

  // A real artifact the run owns, recorded with the hash of the bytes on disk.
  await mkdir(join(cwd, "design"), { recursive: true });
  const artifactBytes = Buffer.from("ISO-10303-21;END-ISO-10303-21;\n");
  await writeFile(join(cwd, "design", "part.step"), artifactBytes);
  loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({
    state: {
      ...state,
      artifacts: { "candidate:authoritative": { id: "candidate:authoritative", path: "design/part.step", sha256: sha256(artifactBytes), role: "authoritative-candidate-design" } },
    },
    event: { type: "ArtifactPublished", data: { id: "candidate:authoritative" } },
  }));

  const promoted = await project.promoteCompletedRun(runId, mechanicalRegistries);
  await writeStatusProjection(cwd, promoted, null);
  return { cwd, runId, promoted: true, evidencePath: evidence.path };
}

async function violationsFor(cwd: string, only?: string[]) {
  const invariants = only ? reifySystemInvariants.filter((invariant) => only.includes(invariant.name)) : reifySystemInvariants;
  const report = await checkReifyInvariants({ cwd, invariants });
  return report.violations;
}

function expectViolation(violations: Array<{ name: string }>, name: string): void {
  assert.ok(violations.some((violation) => violation.name === name), `expected ${name}, saw ${violations.map((violation) => violation.name).join(", ") || "none"}`);
}

test("all system invariants hold on a healthy real Reify project", async () => {
  const fixture = await buildLegalProject();
  try {
    const report = await checkReifyInvariants({ cwd: fixture.cwd });
    assert.deepEqual(report.violations, [], `unexpected violations: ${JSON.stringify(report.violations, null, 2)}`);
    assert.equal(report.checked.length, reifySystemInvariants.length);
    assert.ok(report.checked.length >= 8, "at least eight invariants must be wired to automatic checkers");
    assert.match(report.stateDigest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("invariant catalog keeps P0/P1 coverage and declares a grace budget", () => {
  const p0 = reifySystemInvariants.filter((invariant) => invariant.severity === "P0");
  const p1 = reifySystemInvariants.filter((invariant) => invariant.severity === "P1");
  assert.ok(reifySystemInvariants.length >= 15, `catalog has ${reifySystemInvariants.length} invariants`);
  assert.ok(p0.length + p1.length >= 10, `P0/P1 count is ${p0.length + p1.length}`);
  for (const invariant of reifySystemInvariants) {
    assert.ok(invariant.stateSources.length > 0, `${invariant.name} must name real state sources`);
    assert.ok(invariant.why.trim().length > 0, `${invariant.name} must explain why it exists`);
    assert.ok(Number.isFinite(invariant.graceMs) && invariant.graceMs >= 0, `${invariant.name} must declare a grace window`);
    assert.ok(/^[a-z0-9-]+$/.test(invariant.name), `${invariant.name} must be a stable machine name`);
  }
  assert.equal(new Set(reifySystemInvariants.map((invariant) => invariant.name)).size, reifySystemInvariants.length);
});

test("artifact-integrity catches a changed artifact and missing evidence", async () => {
  const fixture = await buildLegalProject();
  try {
    await writeFile(join(fixture.cwd, "design", "part.step"), "tampered\n");
    expectViolation(await violationsFor(fixture.cwd), "artifact-integrity");

    await writeFile(join(fixture.cwd, "design", "part.step"), "ISO-10303-21;END-ISO-10303-21;\n");
    const runDirectory = join(fixture.cwd, ".pi-cad", "runs", fixture.runId);
    const head = JSON.parse(await readFile(join(runDirectory, "HEAD"), "utf8")) as { txId: string };
    await rm(join(runDirectory, "transactions", head.txId, fixture.evidencePath), { force: true });
    expectViolation(await violationsFor(fixture.cwd), "artifact-integrity");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("terminal-state-stable catches a settled run publishing an active generation", async () => {
  const fixture = await buildLegalProject();
  try {
    const run = new HarnessRunStoreV7(fixture.cwd, fixture.runId);
    await run.mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, status: "active" },
      event: { type: "RunResumed", data: { from: "done", to: "active" } },
    }));
    expectViolation(await violationsFor(fixture.cwd), "terminal-state-stable");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("state-materialization-consistent catches a torn transaction generation", async () => {
  const fixture = await buildLegalProject();
  try {
    const runDirectory = join(fixture.cwd, ".pi-cad", "runs", fixture.runId);
    const head = JSON.parse(await readFile(join(runDirectory, "HEAD"), "utf8")) as { txId: string };
    await writeFile(join(runDirectory, "transactions", head.txId, "state.json"), "{\"schemaVersion\":7}\n");
    const violations = await violationsFor(fixture.cwd);
    expectViolation(violations, "transaction-head-consistent");
    expectViolation(violations, "state-materialization-consistent");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("no-duplicate-effect catches a repeated workspace commit entry", async () => {
  const fixture = await buildLegalProject();
  try {
    const run = new HarnessRunStoreV7(fixture.cwd, fixture.runId);
    await run.mutate(mechanicalRegistries, ({ state }) => ({
      state,
      event: { type: "WorkspaceCommitIndexCorrupted" },
      payloads: { "workspace/commits/index.json": { schema: 1, commits: ["commit-" + "0".repeat(32), "commit-" + "0".repeat(32)] } },
    }));
    expectViolation(await violationsFor(fixture.cwd), "no-duplicate-effect");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("no-orphan-owner catches a lock whose writer process is gone", async () => {
  const fixture = await buildLegalProject();
  try {
    const runDirectory = join(fixture.cwd, ".pi-cad", "runs", fixture.runId);
    await writeFile(join(runDirectory, ".head.lock"), `${JSON.stringify({ schema: 1, pid: 2_147_483_647, createdAt: new Date().toISOString() })}\n`);
    const stale = new Date(Date.now() - 60_000);
    await utimes(join(runDirectory, ".head.lock"), stale, stale);
    expectViolation(await violationsFor(fixture.cwd), "no-orphan-owner");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("conversation-run-binding catches a projection that contradicts the bound run", async () => {
  const fixture = await buildLegalProject();
  try {
    const projectionPath = join(fixture.cwd, ".pi-cad", "status.json");
    const projection = JSON.parse(await readFile(projectionPath, "utf8"));
    // The promoted run really exists, but the projection claims it is active.
    projection.promotedRunId = fixture.runId;
    projection.run = { id: fixture.runId, workflowId: "mechanical.modify", workflowVersion: "1.0.0", workflowHash: "f".repeat(64), phase: "review", status: "active", updatedAt: new Date().toISOString(), phaseHistory: [], phases: [] };
    await chmod(projectionPath, 0o644);
    await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
    expectViolation(await violationsFor(fixture.cwd), "conversation-run-binding");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("projection-store-mismatch explains a projection written by another store", async () => {
  const fixture = await buildLegalProject();
  try {
    const projectionPath = join(fixture.cwd, ".pi-cad", "status.json");
    const projection = JSON.parse(await readFile(projectionPath, "utf8"));
    projection.project.currentRunId = "v7-0000000000000-other";
    projection.run = { id: "v7-0000000000000-other", workflowId: "other", workflowVersion: "1.0.0", workflowHash: "f".repeat(64), phase: "done", status: "done", updatedAt: new Date().toISOString(), phaseHistory: [], phases: [] };
    await chmod(projectionPath, 0o644);
    await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
    const violations = await violationsFor(fixture.cwd);
    expectViolation(violations, "projection-store-mismatch");
    assert.ok(!violations.some((violation) => violation.name === "conversation-run-binding"), "an unknown run id must not be reported as a UI conflict");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("blocked-state-has-blocker catches an unexplained blocked run", async () => {
  const fixture = await buildLegalProject();
  try {
    const run = new HarnessRunStoreV7(fixture.cwd, fixture.runId);
    await run.mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, status: "blocked_external" },
      event: { type: "RunBlocked" },
    }));
    expectViolation(await violationsFor(fixture.cwd), "blocked-state-has-blocker");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("run-ownership-unique catches two sessions writing one run", async () => {
  const fixture = await buildLegalProject();
  try {
    const run = new HarnessRunStoreV7(fixture.cwd, fixture.runId);
    const commit = (id: string, session: string) => ({
      schema: 1, id, name: `step-${session}`, parent: null, workflowHash: "", phase: "done",
      variables: {}, artifacts: [], producer: { transport: "json-cli", session }, createdAt: new Date().toISOString(),
    });
    const alpha = commit(`commit-${"1".repeat(32)}`, "session-a");
    const beta = commit(`commit-${"2".repeat(32)}`, "session-b");
    alpha.workflowHash = (await run.load(mechanicalRegistries))!.workflow.hash;
    beta.workflowHash = alpha.workflowHash;
    await run.mutate(mechanicalRegistries, ({ state }) => ({
      state,
      event: { type: "CrossSessionCommits" },
      payloads: {
        [`workspace/commits/${alpha.id}.json`]: jsonValue(alpha),
        [`workspace/commits/${beta.id}.json`]: jsonValue(beta),
        "workspace/commits/index.json": { schema: 1, commits: [alpha.id, beta.id] },
      },
    }));
    expectViolation(await violationsFor(fixture.cwd), "run-ownership-unique");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("single-active-runtime-per-run and no-abandoned-runtime read real runtime records", async () => {
  const fixture = await buildLegalProject();
  try {
    const runDirectory = join(fixture.cwd, ".pi-cad", "runs", fixture.runId);
    const running = { schema: 1, runId: "recipe-1", workflowRunId: fixture.runId, recipeId: "simulation", recipeKind: "simulation", recipeVersion: "1.0.0", action: "run", requestedOutputs: [], sourceRecipePath: "recipes/simulation", workflowHash: "a".repeat(64), registryContractHash: "b".repeat(64), phaseAtPrepare: "review", runtimeIdentity: { profileId: "local", platform: "linux", version: "1", digest: "c".repeat(64), launcher: "node" }, actionHash: "d".repeat(64), observerHash: "e".repeat(64), inputHashes: {}, computeIdentity: "f".repeat(64), status: "running", createdAt: new Date().toISOString() };
    for (const id of ["recipe-1", "recipe-2"]) {
      const store = new TransactionStore(join(runDirectory, "recipe-runs", id, "record"));
      await store.commit({ expectedGeneration: 0, payloads: { "run.json": { ...running, runId: id } }, event: { type: "RecipeStarted", data: { runId: id } } });
      const recordPath = join(runDirectory, "recipe-runs", id, "record", "run.json");
      const stale = new Date(Date.now() - 10 * 60_000);
      await utimes(recordPath, stale, stale);
    }
    const violations = await violationsFor(fixture.cwd);
    expectViolation(violations, "single-active-runtime-per-run");
    expectViolation(violations, "no-abandoned-runtime");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("recovery-convergence fires only on a live status that stopped advancing", async () => {
  const fixture = await buildLegalProject();
  try {
    const run = new HarnessRunStoreV7(fixture.cwd, fixture.runId);
    await run.mutate(mechanicalRegistries, ({ state }) => ({ state: { ...state, status: "active" }, event: { type: "RunResumed" } }));
    const headPath = join(fixture.cwd, ".pi-cad", "runs", fixture.runId, "HEAD");
    const stale = new Date(Date.now() - 10 * 60_000);
    await utimes(headPath, stale, stale);
    expectViolation(await violationsFor(fixture.cwd), "recovery-convergence");

    // A run parked on a human decision is not a convergence failure.
    await run.mutate(mechanicalRegistries, ({ state }) => ({ state: { ...state, status: "waiting_user" }, event: { type: "RunWaiting" } }));
    await utimes(headPath, stale, stale);
    const manual = await violationsFor(fixture.cwd, ["recovery-convergence"]);
    assert.deepEqual(manual, []);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("the chaos-invariants CLI runs the checkers and reports the artifact", async () => {
  const fixture = await buildLegalProject();
  try {
    const artifact = join(fixture.cwd, "artifact.json");
    const { stdout } = await execFileAsync(process.execPath, [
      join(repositoryRoot, "scripts", "chaos-invariants.mjs"),
      "--cwd", fixture.cwd,
      "--artifact", artifact,
    ], { cwd: repositoryRoot });
    assert.match(stdout, /checked \d+ invariant/);
    const report = JSON.parse(await readFile(artifact, "utf8"));
    assert.deepEqual(report.violations, []);
    assert.equal(report.checked.length, reifySystemInvariants.length);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});
