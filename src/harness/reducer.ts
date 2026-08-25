import { canonicalDigest, type JsonValue } from "./canonical.ts";
import type { RegistryContractV1 } from "./registry-contract.ts";
import type { EvidenceRefV7, HarnessRunStateV7, RecipeObligationBindingV7, RecordRefV7 } from "./state.ts";
import type { WorkflowObligationDefinition, WorkflowSnapshotV1 } from "./workflow/types.ts";

function now(): string { return new Date().toISOString(); }

function currentPhase(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1) {
  if (state.workflow.hash !== workflow.hash) throw new Error("state/workflow hash mismatch");
  const phase = workflow.phases[state.phase];
  if (!phase) throw new Error(`state phase is absent from workflow: ${state.phase}`);
  return phase;
}

function currentObligation(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, ref: string, kind: "record" | "evidence"): WorkflowObligationDefinition {
  const phase = currentPhase(state, workflow);
  const obligations = kind === "record" ? phase.recordObligations : phase.evidenceObligations;
  const obligation = obligations.find((item) => item.ref === ref);
  if (!obligation) throw new Error(`${kind} obligation is not current: ${ref}`);
  return obligation;
}

function assertDependenciesClosed(state: HarnessRunStateV7, obligation: WorkflowObligationDefinition): void {
  const unmet = (obligation.dependsOn ?? []).filter((ref) => !state.records[ref] && !state.evidence.some((item) => item.obligationRef === ref));
  if (unmet.length) throw new Error(`obligation dependencies remain unmet for ${obligation.ref}: ${unmet.join(", ")}`);
}

export function createHarnessRunState(input: {
  runId: string;
  projectId: string;
  workflow: WorkflowSnapshotV1;
  registryContract: RegistryContractV1;
  parameters?: Record<string, JsonValue>;
  interactionMode?: "interactive" | "headless";
}): HarnessRunStateV7 {
  const at = now();
  return {
    schemaVersion: 7, kernelVersion: "v7", runId: input.runId, projectId: input.projectId,
    workflow: {
      id: input.workflow.id, version: input.workflow.version, hash: input.workflow.hash,
      snapshotPath: "workflow.json", registryContractHash: input.registryContract.hash,
      parameters: input.parameters ?? {}, history: [],
    },
    phase: input.workflow.initialPhase, status: "active", interactionMode: input.interactionMode ?? "interactive",
    phaseHistory: [input.workflow.initialPhase],
    records: {}, artifacts: {}, evidence: [], staleEvidence: [], authorities: [],
    createdAt: at, updatedAt: at,
  };
}

export function transitionRun(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, event: string): HarnessRunStateV7 {
  if (state.status !== "active" && state.status !== "ready") throw new Error(`cannot transition run in status ${state.status}`);
  const phase = currentPhase(state, workflow);
  const transition = phase.transitions[event];
  if (!transition) throw new Error(`illegal workflow transition: ${state.phase}.${event}`);
  if (transition.requiresPhaseObligations) {
    const unmet = unmetPhaseObligations(state, workflow, state.phase);
    if (unmet.length) throw new Error(`phase obligations remain unmet: ${unmet.join(", ")}`);
  }
  if (event === "accepted" && phase.reviewProfile) {
    const review = state.latestReview;
    const subjectHash = canonicalDigest({ workflowHash: workflow.hash, registryContractHash: state.workflow.registryContractHash, phase: state.phase, records: state.records, artifacts: state.artifacts, evidence: state.evidence, latestObservation: state.contextRefs?.latestObservation ?? null });
    if (!review || review.verdict !== "pass" || review.profileId !== phase.reviewProfile || review.workflowHash !== workflow.hash || review.registryContractHash !== state.workflow.registryContractHash || review.subjectHash !== subjectHash) throw new Error(`transition requires a current ${phase.reviewProfile} PASS`);
  }
  let authorities = state.authorities;
  if (transition.authority) {
    const index = authorities.findIndex((item) => item.kind === transition.authority && !item.consumedAt);
    if (index < 0) throw new Error(`transition requires authority: ${transition.authority}`);
    authorities = authorities.map((item, itemIndex) => itemIndex === index ? { ...item, consumedAt: now() } : item);
  }
  const target = workflow.phases[transition.target]!;
  return {
    ...state,
    phase: transition.target,
    phaseHistory: [...(state.phaseHistory ?? [state.phase]), transition.target],
    status: transition.terminalStatus
      ? transition.terminalStatus as HarnessRunStateV7["status"]
      : target.terminal ? "done" : transition.target === "ready" ? "ready" : "active",
    authorities,
    updatedAt: now(),
  };
}

export function commitRecordRef(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, ref: RecordRefV7): HarnessRunStateV7 {
  const obligation = currentObligation(state, workflow, ref.obligationRef, "record");
  assertDependenciesClosed(state, obligation);
  if (obligation.type !== ref.type || ref.workflowHash !== workflow.hash) throw new Error(`record does not match obligation: ${ref.obligationRef}`);
  const existing = state.records[ref.obligationRef];
  if (existing) {
    if (existing.sha256 === ref.sha256 && existing.path === ref.path) return state;
    throw new Error(`record obligation already closed: ${ref.obligationRef}`);
  }
  return { ...state, records: { ...state.records, [ref.obligationRef]: ref }, updatedAt: now() };
}

function dependencyClosure(workflow: WorkflowSnapshotV1, changedRefs: ReadonlySet<string>): Set<string> {
  const invalid = new Set(changedRefs);
  const obligations = Object.values(workflow.phases).flatMap((phase) => [...phase.recordObligations, ...phase.evidenceObligations]);
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const item of obligations) {
      if (!invalid.has(item.ref) && (item.dependsOn ?? []).some((dependency) => invalid.has(dependency))) {
        invalid.add(item.ref);
        advanced = true;
      }
    }
  }
  return invalid;
}

/** Replace one authoritative record and invalidate all declared dependants. */
export function reviseRecordRef(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, ref: RecordRefV7): HarnessRunStateV7 {
  const obligation = Object.values(workflow.phases).flatMap((phase) => phase.recordObligations).find((item) => item.ref === ref.obligationRef);
  if (!obligation || obligation.type !== ref.type || ref.workflowHash !== workflow.hash) throw new Error(`record revision does not match workflow: ${ref.obligationRef}`);
  const existing = state.records[ref.obligationRef];
  if (!existing) return commitRecordRef(state, workflow, ref);
  if (existing.sha256 === ref.sha256 && existing.path === ref.path) return state;
  const invalid = dependencyClosure(workflow, new Set([ref.obligationRef]));
  const records = Object.fromEntries(Object.entries(state.records).filter(([key]) => !invalid.has(key)));
  records[ref.obligationRef] = ref;
  const stale = state.evidence.filter((item) => invalid.has(item.obligationRef));
  return {
    ...state,
    records,
    evidence: state.evidence.filter((item) => !invalid.has(item.obligationRef)),
    staleEvidence: [...state.staleEvidence, ...stale],
    latestReview: undefined,
    status: "active",
    updatedAt: now(),
  };
}

export function prepareRecipeObligation(input: {
  state: HarnessRunStateV7;
  workflow: WorkflowSnapshotV1;
  registryContract: RegistryContractV1;
  obligationRef: string;
  recipeKind: string;
  requestedOutputs?: string[];
}): RecipeObligationBindingV7 {
  if (input.state.workflow.registryContractHash !== input.registryContract.hash) throw new Error("state/Registry Contract hash mismatch");
  const obligation = currentObligation(input.state, input.workflow, input.obligationRef, "evidence");
  assertDependenciesClosed(input.state, obligation);
  if (input.state.evidence.some((item) => item.obligationRef === obligation.ref)) throw new Error(`evidence obligation already closed: ${obligation.ref}`);
  if (!obligation.recipeKind) throw new Error(`evidence obligation is not Recipe-backed: ${obligation.ref}`);
  if (obligation.recipeKind !== input.recipeKind) throw new Error(`Recipe kind cannot close ${obligation.ref}: ${input.recipeKind}`);
  const requested = new Set(input.requestedOutputs ?? []);
  const missingOutputs = (obligation.requiredOutputs ?? []).filter((name) => !requested.has(name));
  if (missingOutputs.length) throw new Error(`Recipe does not request required obligation outputs for ${obligation.ref}: ${missingOutputs.join(", ")}`);
  return {
    obligationRef: obligation.ref,
    evidenceType: obligation.type,
    recipeKind: input.recipeKind,
    requiredOutputs: [...(obligation.requiredOutputs ?? [])],
    workflowHash: input.workflow.hash,
    registryContractHash: input.registryContract.hash,
    phaseAtPrepare: input.state.phase,
  };
}

export function commitBoundEvidence(input: {
  state: HarnessRunStateV7;
  workflow: WorkflowSnapshotV1;
  registryContract: RegistryContractV1;
  binding: RecipeObligationBindingV7;
  evidence: EvidenceRefV7;
}): HarnessRunStateV7 {
  const { state, workflow, registryContract, binding, evidence } = input;
  if (binding.workflowHash !== workflow.hash || state.workflow.hash !== workflow.hash || evidence.workflowHash !== workflow.hash) throw new Error("evidence workflow binding is stale");
  if (binding.registryContractHash !== registryContract.hash || state.workflow.registryContractHash !== registryContract.hash || evidence.registryContractHash !== registryContract.hash) throw new Error("evidence Registry Contract binding is stale");
  if (binding.phaseAtPrepare !== state.phase) throw new Error("evidence phase binding is stale");
  const obligation = currentObligation(state, workflow, binding.obligationRef, "evidence");
  assertDependenciesClosed(state, obligation);
  if (obligation.type !== binding.evidenceType || evidence.type !== obligation.type || evidence.obligationRef !== obligation.ref) throw new Error("evidence does not match its pre-bound obligation");
  const existing = state.evidence.find((item) => item.obligationRef === obligation.ref);
  if (existing) {
    if (existing.sha256 === evidence.sha256 && existing.path === evidence.path) return state;
    throw new Error(`evidence obligation already closed: ${obligation.ref}`);
  }
  return { ...state, evidence: [...state.evidence, evidence], updatedAt: now() };
}

/** Commit evidence produced by a primitive/domain hook (Recipe evidence uses the stricter pre-bound path above). */
export function commitEvidenceRef(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, registryContract: RegistryContractV1, evidence: EvidenceRefV7): HarnessRunStateV7 {
  const obligation = currentObligation(state, workflow, evidence.obligationRef, "evidence");
  if (obligation.recipeKind) throw new Error(`Recipe-backed evidence requires a pre-bound Recipe run: ${obligation.ref}`);
  assertDependenciesClosed(state, obligation);
  if (obligation.type !== evidence.type || evidence.workflowHash !== workflow.hash || evidence.registryContractHash !== registryContract.hash) throw new Error(`evidence does not match obligation: ${obligation.ref}`);
  const existing = state.evidence.find((item) => item.obligationRef === obligation.ref);
  if (existing) {
    if (existing.sha256 === evidence.sha256 && existing.path === evidence.path) return state;
    throw new Error(`evidence obligation already closed: ${obligation.ref}`);
  }
  return { ...state, evidence: [...state.evidence, evidence], updatedAt: now() };
}

export function unmetWorkflowObligations(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): string[] {
  const refs = new Set<string>();
  const visited = new Set(state.phaseHistory ?? [state.phase]);
  for (const [phaseId, phase] of Object.entries(workflow.phases)) {
    if (!visited.has(phaseId)) continue;
    for (const item of phase.recordObligations) if (item.required !== false && !state.records[item.ref]) refs.add(item.ref);
    for (const item of phase.evidenceObligations) if (item.required !== false && !state.evidence.some((evidence) => evidence.obligationRef === item.ref)) refs.add(item.ref);
  }
  return [...refs].sort();
}

export function unmetPhaseObligations(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1, phaseId = state.phase): string[] {
  const phase = workflow.phases[phaseId];
  if (!phase) throw new Error(`workflow phase does not exist: ${phaseId}`);
  return [
    ...phase.recordObligations.filter((item) => item.required !== false && !state.records[item.ref]).map((item) => item.ref),
    ...phase.evidenceObligations.filter((item) => item.required !== false && !state.evidence.some((evidence) => evidence.obligationRef === item.ref)).map((item) => item.ref),
  ].sort();
}

export function finishRun(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): HarnessRunStateV7 {
  const unmet = unmetWorkflowObligations(state, workflow);
  if (unmet.length) throw new Error(`workflow obligations remain unmet: ${unmet.join(", ")}`);
  const phase = currentPhase(state, workflow);
  const finishEvent = Object.entries(phase.transitions).find(([event, transition]) => event === "finished" || workflow.phases[transition.target]?.terminal);
  if (!finishEvent) throw new Error(`phase ${state.phase} has no finish transition`);
  return transitionRun(state, workflow, finishEvent[0]);
}

export function replaceWorkflowSnapshot(input: {
  state: HarnessRunStateV7;
  predecessor: WorkflowSnapshotV1;
  successor: WorkflowSnapshotV1;
  registryContract: RegistryContractV1;
  reason: string;
  authority?: string;
  initialPhase?: string;
  preserveCompatibleObligations?: boolean;
}): HarnessRunStateV7 {
  if (input.state.workflow.hash !== input.predecessor.hash) throw new Error("workflow replacement predecessor mismatch");
  if (!input.reason.trim()) throw new Error("workflow replacement reason is required");
  const phase = input.initialPhase ?? input.successor.initialPhase;
  if (!input.successor.phases[phase]) throw new Error(`workflow replacement phase does not exist: ${phase}`);
  const at = now();
  const recordTypes = new Map(Object.values(input.successor.phases).flatMap((phase) => phase.recordObligations).map((item) => [item.ref, item.type]));
  const evidenceTypes = new Map(Object.values(input.successor.phases).flatMap((phase) => phase.evidenceObligations).map((item) => [item.ref, item.type]));
  const records = input.preserveCompatibleObligations
    ? Object.fromEntries(Object.entries(input.state.records).filter(([ref, value]) => recordTypes.get(ref) === value.type))
    : {};
  const evidence = input.preserveCompatibleObligations
    ? input.state.evidence.filter((value) => evidenceTypes.get(value.obligationRef) === value.type)
    : [];
  const retainedEvidenceIds = new Set(evidence.map((value) => value.id));
  return {
    ...input.state,
    workflow: {
      id: input.successor.id,
      version: input.successor.version,
      hash: input.successor.hash,
      snapshotPath: "workflow.json",
      registryContractHash: input.registryContract.hash,
      parameters: input.state.workflow.parameters,
      history: [...input.state.workflow.history, {
        reason: input.reason,
        ...(input.authority ? { authority: input.authority } : {}),
        predecessorHash: input.predecessor.hash,
        successorHash: input.successor.hash,
        at,
      }],
    },
    phase,
    phaseHistory: [phase],
    status: input.successor.phases[phase]!.terminal ? "done" : "active",
    records,
    staleEvidence: [...input.state.staleEvidence, ...input.state.evidence.filter((value) => !retainedEvidenceIds.has(value.id))],
    evidence,
    blocker: undefined,
    updatedAt: at,
  };
}
