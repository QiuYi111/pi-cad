import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { commitBoundEvidence, commitRecordRef, finishRun, prepareRecipeObligation, transitionRun } from "../src/harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { TransactionConflictError, TransactionStore, type TransactionFaultPoint } from "../src/harness/transaction-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("transaction commit point exposes only parent or committed generation and recovery is idempotent", async () => {
  for (const point of ["after_payloads", "after_manifest", "after_commit", "after_head", "after_materialize"] as TransactionFaultPoint[]) {
    const cwd = await mkdtemp(join(tmpdir(), `pi-cad-tx-${point}-`));
    try {
      const store = new TransactionStore(join(cwd, "run"));
      await assert.rejects(store.commit({ expectedGeneration: 0, payloads: { "state.json": { value: 1 } }, event: { type: "Changed" }, faultAt: point }), /injected transaction crash/);
      const head = await store.readHead();
      if (point === "after_head" || point === "after_materialize") {
        assert.equal(head?.generation, 1);
        await store.recover();
        await store.recover();
        assert.deepEqual(await store.readJson("state.json"), { value: 1 });
        const events = (await readFile(join(cwd, "run", "events.jsonl"), "utf-8")).trim().split("\n");
        assert.equal(events.length, 1, "recovery must derive each committed event exactly once");
      } else {
        assert.equal(head, null, `${point} must not publish a partial generation`);
        await store.recover();
        assert.equal(await store.readJson("state.json"), null);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("transaction CAS rejects concurrent writers and payload corruption fails closed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-tx-cas-"));
  try {
    const store = new TransactionStore(join(cwd, "run"));
    const results = await Promise.allSettled([1, 2].map((value) => store.commit({ expectedGeneration: 0, payloads: { "state.json": { value } }, event: { type: "Changed", data: { value } } })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof TransactionConflictError);
    const head = (await store.readHead())!;
    await writeFile(join(cwd, "run", "transactions", head.txId, "state.json"), "tampered");
    await assert.rejects(store.readJson("state.json"), /payload hash mismatch/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit recovery removes only a lock whose owner process is gone", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-tx-lock-"));
  try {
    const store = new TransactionStore(join(cwd, "run"));
    await store.commit({ expectedGeneration: 0, payloads: { "state.json": { value: 1 } }, event: { type: "Created" } });
    await writeFile(join(cwd, "run", ".head.lock"), JSON.stringify({ schema: 1, pid: 2_147_483_647 }));
    await store.recover();
    await store.commit({ expectedGeneration: 1, payloads: { "state.json": { value: 2 } }, event: { type: "Changed" } });
    assert.deepEqual(await store.readJson("state.json"), { value: 2 });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

const WALKING_WORKFLOW = {
  schema: 1,
  id: "test/walking-skeleton",
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

test("transactional v7 walking skeleton pins contracts and pre-binds Recipe evidence obligations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-walk-"));
  try {
    const workflow = compileWorkflowDefinition(WALKING_WORKFLOW, mechanicalRegistries);
    const contract = buildRegistryContract(mechanicalRegistries);
    const project = new HarnessProjectStoreV7(cwd);
    let loaded = await project.startRun({ workflow, registryContract: contract });
    const run = new HarnessRunStoreV7(cwd, loaded.state.runId);
    assert.equal((await project.currentRun(mechanicalRegistries))?.state.phase, "requirements");

    loaded = await run.mutate(mechanicalRegistries, ({ state, workflow: current }) => ({
      state: commitRecordRef(state, current, { obligationRef: "record:requirements", type: "requirements", path: "records/requirements.json", sha256: "a".repeat(64), workflowHash: current.hash, createdAt: new Date().toISOString() }),
      event: { type: "RecordCommitted", data: { obligationRef: "record:requirements" } },
      payloads: { "records/requirements.json": { goal: "walking skeleton" } },
    }));
    for (const event of ["committed", "planned", "built"]) loaded = await run.mutate(mechanicalRegistries, ({ state, workflow: current }) => ({ state: transitionRun(state, current, event), event: { type: "Transitioned", data: { event } } }));
    const binding = prepareRecipeObligation({ state: loaded.state, workflow, registryContract: contract, obligationRef: "simulation:load-case-1", recipeKind: "simulation" });
    assert.equal(binding.obligationRef, "simulation:load-case-1");
    assert.throws(() => prepareRecipeObligation({ state: loaded.state, workflow, registryContract: contract, obligationRef: "simulation:not-this-case", recipeKind: "simulation" }), /not current/);
    loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({
      state: commitBoundEvidence({
        state, workflow, registryContract: contract, binding,
        evidence: { id: "ev-1", obligationRef: binding.obligationRef, type: "simulation", path: "evidence/simulation/ev-1.json", sha256: "b".repeat(64), workflowHash: workflow.hash, registryContractHash: contract.hash, computeIdentity: "c".repeat(64), createdAt: new Date().toISOString() },
      }),
      event: { type: "EvidenceCommitted", data: { obligationRef: binding.obligationRef } },
      payloads: { "evidence/simulation/ev-1.json": { valid: true } },
    }));
    loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({ state: transitionRun(state, workflow, "accepted"), event: { type: "Transitioned", data: { event: "accepted" } } }));
    loaded = await run.mutate(mechanicalRegistries, ({ state }) => ({ state: finishRun(state, workflow), event: { type: "RunFinished" } }));
    assert.equal(loaded.state.phase, "done");
    assert.equal(loaded.state.status, "done");
    const promoted = await project.promoteCompletedRun(loaded.state.runId, mechanicalRegistries);
    assert.equal(promoted.currentRunId, null);
    assert.equal(promoted.promotedRunId, loaded.state.runId);
    assert.equal((await project.promoteCompletedRun(loaded.state.runId, mechanicalRegistries)).promotedRunId, loaded.state.runId);
    assert.equal((await readdir(join(cwd, ".pi-cad", "runs", loaded.state.runId, "transactions"))).length, 8);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
