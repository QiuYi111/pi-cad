import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { canonicalDigest, jsonValue, type JsonValue } from "./canonical.ts";
import { assertRegistryContractCompatible, registryContractHash, type RegistryContractV1 } from "./registry-contract.ts";
import type { RegistrySet } from "./registry.ts";
import { createHarnessRunState } from "./reducer.ts";
import type { HarnessRunStateV7 } from "./state.ts";
import { TransactionConflictError, TransactionStore, type HeadPointerV1, type TransactionEventV1 } from "./transaction-store.ts";
import type { WorkflowSnapshotV1 } from "./workflow/types.ts";
import { harnessProjectDirectory, harnessRunDirectory, harnessStorageRoot } from "../authority/storage.ts";

export interface LoadedHarnessRunV7 {
  head: HeadPointerV1;
  state: HarnessRunStateV7;
  workflow: WorkflowSnapshotV1;
  registryContract: RegistryContractV1;
}

export interface HarnessMutationV7 {
  state: HarnessRunStateV7;
  event: TransactionEventV1;
  payloads?: Record<string, string | Buffer | JsonValue>;
}

function workflowHash(workflow: WorkflowSnapshotV1): string {
  const { hash: _hash, ...body } = workflow;
  return canonicalDigest(body);
}

export class HarnessRunStoreV7 {
  readonly cwd: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly transactions: TransactionStore;

  constructor(cwd: string, runId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) throw new Error(`invalid v7 run ID: ${runId}`);
    this.cwd = resolve(cwd);
    this.runId = runId;
    this.runDirectory = harnessRunDirectory(this.cwd, runId);
    this.transactions = new TransactionStore(this.runDirectory);
  }

  async initialize(input: {
    state: HarnessRunStateV7;
    workflow: WorkflowSnapshotV1;
    registryContract: RegistryContractV1;
  }): Promise<LoadedHarnessRunV7> {
    if (await this.transactions.readHead()) throw new Error(`v7 run already exists: ${this.runId}`);
    if (input.state.runId !== this.runId || input.state.workflow.hash !== input.workflow.hash || input.state.workflow.registryContractHash !== input.registryContract.hash) throw new Error("v7 run initialization identity mismatch");
    const head = await this.transactions.commit({
      expectedGeneration: 0,
      payloads: {
        "state.json": jsonValue(input.state),
        "workflow.json": jsonValue(input.workflow),
        "registry-contract.json": jsonValue(input.registryContract),
        "indexes/obligations.json": jsonValue({ schema: 1, records: {}, evidence: {} }),
        "context/frame.json": jsonValue({ schema: 1, fragments: [], updatedAt: input.state.createdAt }),
      },
      event: { type: "RunStarted", data: { runId: this.runId, workflowHash: input.workflow.hash, registryContractHash: input.registryContract.hash } },
    });
    return { head, state: input.state, workflow: input.workflow, registryContract: input.registryContract };
  }

  async load(registries?: RegistrySet): Promise<LoadedHarnessRunV7 | null> {
    const head = await this.transactions.readHead();
    if (!head) return null;
    const [state, workflow, registryContract] = await Promise.all([
      this.transactions.readJson<HarnessRunStateV7>("state.json"),
      this.transactions.readJson<WorkflowSnapshotV1>("workflow.json"),
      this.transactions.readJson<RegistryContractV1>("registry-contract.json"),
    ]);
    if (!state || !workflow || !registryContract) throw new Error("v7 run transaction lacks a required snapshot");
    if (state.schemaVersion !== 7 || state.kernelVersion !== "v7" || state.runId !== this.runId) throw new Error("invalid v7 state snapshot");
    if (workflow.hash !== workflowHash(workflow) || registryContract.hash !== registryContractHash(registryContract)) throw new Error("v7 workflow or Registry Contract hash mismatch");
    if (state.workflow.hash !== workflow.hash || state.workflow.registryContractHash !== registryContract.hash) throw new Error("v7 state snapshot references incompatible contracts");
    if (registries) assertRegistryContractCompatible(registryContract, registries);
    return { head, state, workflow, registryContract };
  }

  async mutate(
    registries: RegistrySet,
    reducer: (loaded: LoadedHarnessRunV7) => Promise<HarnessMutationV7> | HarnessMutationV7,
    attempts = 3,
  ): Promise<LoadedHarnessRunV7> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const loaded = await this.load(registries);
      if (!loaded) throw new Error(`v7 run does not exist: ${this.runId}`);
      const mutation = await reducer(loaded);
      const inherited = await this.transactions.readSnapshotPayloads();
      if (mutation.state.runId !== this.runId || mutation.state.workflow.hash !== loaded.workflow.hash || mutation.state.workflow.registryContractHash !== loaded.registryContract.hash) throw new Error("v7 reducer changed pinned identity");
      try {
        const head = await this.transactions.commit({
          expectedGeneration: loaded.head.generation,
          payloads: {
            ...inherited,
            "state.json": jsonValue(mutation.state),
            "workflow.json": jsonValue(loaded.workflow),
            "registry-contract.json": jsonValue(loaded.registryContract),
            ...(mutation.payloads ?? {}),
          },
          event: mutation.event,
        });
        return { ...loaded, head, state: mutation.state };
      } catch (error) {
        if (!(error instanceof TransactionConflictError) || attempt === attempts - 1) throw error;
      }
    }
    throw new Error("unreachable v7 mutation retry state");
  }

  async replaceWorkflow(input: {
    expectedGeneration: number;
    state: HarnessRunStateV7;
    workflow: WorkflowSnapshotV1;
    registryContract: RegistryContractV1;
    event: TransactionEventV1;
  }): Promise<LoadedHarnessRunV7> {
    if (input.state.workflow.hash !== input.workflow.hash || input.state.workflow.registryContractHash !== input.registryContract.hash) throw new Error("workflow replacement identity mismatch");
    const inherited = await this.transactions.readSnapshotPayloads();
    const head = await this.transactions.commit({
      expectedGeneration: input.expectedGeneration,
      payloads: {
        ...inherited,
        "state.json": jsonValue(input.state),
        "workflow.json": jsonValue(input.workflow),
        "registry-contract.json": jsonValue(input.registryContract),
      },
      event: input.event,
    });
    return { head, state: input.state, workflow: input.workflow, registryContract: input.registryContract };
  }

  recover(): Promise<HeadPointerV1 | null> {
    return this.transactions.recover();
  }
}

export interface HarnessProjectStateV7 {
  schema: 1;
  kernelVersion: "v7";
  projectId: string;
  currentRunId: string | null;
  runs: Array<{ runId: string; workflowHash: string; createdAt: string }>;
  head: { artifacts: Record<string, { path: string; sha256: string; role: string }>; updatedAt: string };
  promotedRunId?: string;
  updatedAt: string;
}

export class HarnessProjectStoreV7 {
  readonly cwd: string;
  readonly directory: string;
  readonly transactions: TransactionStore;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.directory = harnessProjectDirectory(this.cwd);
    this.transactions = new TransactionStore(this.directory);
  }

  async load(): Promise<{ head: HeadPointerV1 | null; state: HarnessProjectStateV7 }> {
    const head = await this.transactions.readHead();
    const state = head ? await this.transactions.readJson<HarnessProjectStateV7>("state.json") : null;
    if (state) return { head, state };
    const at = new Date().toISOString();
    return {
      head: null,
      state: { schema: 1, kernelVersion: "v7", projectId: basename(this.cwd) || "project", currentRunId: null, runs: [], head: { artifacts: {}, updatedAt: at }, updatedAt: at },
    };
  }

  async startRun(input: {
    workflow: WorkflowSnapshotV1;
    registryContract: RegistryContractV1;
    parameters?: Record<string, JsonValue>;
    interactionMode?: "interactive" | "headless";
  }): Promise<LoadedHarnessRunV7> {
    const runId = `v7-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const initial = await this.load();
    const state = createHarnessRunState({ runId, projectId: initial.state.projectId, workflow: input.workflow, registryContract: input.registryContract, parameters: input.parameters, interactionMode: input.interactionMode });
    const run = new HarnessRunStoreV7(this.cwd, runId);
    const loaded = await run.initialize({ state, workflow: input.workflow, registryContract: input.registryContract });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = await this.load();
      const next: HarnessProjectStateV7 = {
        ...project.state,
        currentRunId: runId,
        runs: [...project.state.runs, { runId, workflowHash: input.workflow.hash, createdAt: state.createdAt }],
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.transactions.commit({ expectedGeneration: project.head?.generation ?? 0, payloads: { "state.json": jsonValue(next) }, event: { type: "ProjectRunSelected", data: { runId } } });
        return loaded;
      } catch (error) {
        if (!(error instanceof TransactionConflictError) || attempt === 2) throw error;
      }
    }
    throw new Error("unreachable v7 project mutation retry state");
  }

  async currentRun(registries?: RegistrySet): Promise<LoadedHarnessRunV7 | null> {
    const { state } = await this.load();
    return state.currentRunId ? new HarnessRunStoreV7(this.cwd, state.currentRunId).load(registries) : null;
  }

  /**
   * Project HEAD is the final visibility pointer. A completed run is first
   * committed in its own store; this single project transaction then
   * publishes all declared artifacts and deselects the run. Replaying after
   * a crash is idempotent by promotedRunId.
   */
  async promoteCompletedRun(runId: string, registries: RegistrySet): Promise<HarnessProjectStateV7> {
    const run = await new HarnessRunStoreV7(this.cwd, runId).load(registries);
    if (!run || run.state.status !== "done") throw new Error(`cannot promote incomplete v7 run: ${runId}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = await this.load();
      if (project.state.promotedRunId === runId) return project.state;
      if (project.state.currentRunId !== runId) throw new Error(`project no longer selects run for promotion: ${runId}`);
      const at = new Date().toISOString();
      const next: HarnessProjectStateV7 = {
        ...project.state,
        currentRunId: null,
        promotedRunId: runId,
        head: { artifacts: { ...run.state.artifacts }, updatedAt: at },
        updatedAt: at,
      };
      try {
        await this.transactions.commit({
          expectedGeneration: project.head?.generation ?? 0,
          payloads: { "state.json": jsonValue(next) },
          event: { type: "ProjectHeadPromoted", data: { runId, artifacts: Object.keys(next.head.artifacts).sort() } },
        });
        return next;
      } catch (error) {
        if (!(error instanceof TransactionConflictError) || attempt === 2) throw error;
      }
    }
    throw new Error("unreachable v7 Project Head promotion retry state");
  }

  async reconcileCompletedRun(registries: RegistrySet): Promise<HarnessProjectStateV7 | null> {
    const { state } = await this.load();
    if (!state.currentRunId) return null;
    const run = await new HarnessRunStoreV7(this.cwd, state.currentRunId).load(registries);
    if (!run || run.state.status !== "done") return null;
    return this.promoteCompletedRun(run.state.runId, registries);
  }

  async deselectRun(runId: string, reason: string): Promise<HarnessProjectStateV7> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = await this.load();
      if (project.state.currentRunId === null) return project.state;
      if (project.state.currentRunId !== runId) throw new Error(`project selects a different v7 run: ${project.state.currentRunId}`);
      const next = { ...project.state, currentRunId: null, updatedAt: new Date().toISOString() };
      try {
        await this.transactions.commit({ expectedGeneration: project.head?.generation ?? 0, payloads: { "state.json": jsonValue(next) }, event: { type: "ProjectRunDeselected", data: { runId, reason } } });
        return next;
      } catch (error) {
        if (!(error instanceof TransactionConflictError) || attempt === 2) throw error;
      }
    }
    throw new Error("unreachable v7 project deselection retry state");
  }

  async listRunIds(): Promise<string[]> {
    try { return (await readdir(join(harnessStorageRoot(this.cwd), "runs"))).filter((name) => name.startsWith("v7-")).sort(); }
    catch { return []; }
  }
}
