import {
  ALL_WORKFLOWS,
  type CadPhase,
  type CadPlan,
  type CadRunState,
  type CadRequirements,
  type CadWorkflow,
  type EvidenceInputArtifact,
  type EvidenceRef,
  type MutationPolicy,
} from "../shared/protocol.ts";
import { hashRecord, makeEvidenceId, nowIso } from "../shared/store.ts";
import { caseObligationFailure } from "./evidence-cases.ts";
import { WORKFLOW_SPECS } from "../workflows/index.ts";
import type { WorkflowSpec } from "../workflows/types.ts";

export const WORKFLOWS: Record<CadWorkflow, WorkflowSpec> = WORKFLOW_SPECS;

const SOURCE_PHASES = new Set<CadPhase>(["build", "modify", "convert"]);
export function workflowSpec(state: CadRunState): WorkflowSpec | null {
  return state.workflow ? WORKFLOWS[state.workflow] : null;
}

export function mutationPolicyForPhase(
  phase: CadPhase,
  workflow?: CadWorkflow,
): MutationPolicy {
  const spec = workflow ? WORKFLOWS[workflow] : undefined;
  const override = spec?.mutationPolicies?.[phase];
  if (override) return override;
  if (SOURCE_PHASES.has(phase)) return "source_only";
  return "read_only";
}

export interface CreateIntakeOptions {
  runId?: string;
  projectId?: string;
}

export function createIntakeState(options: CreateIntakeOptions = {}): CadRunState {
  const createdAt = nowIso();
  return {
    schemaVersion: 3,
    runId:
      options.runId ??
      `run-${createdAt.slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: options.projectId ?? "project",
    createdAt,
    workflow: null,
    phase: "intake",
    status: "active",
    maturity: "prototype",
    mutationPolicy: "read_only",
    evidence: [],
    staleEvidence: [],
    activeWorkstreams: [],
    updatedAt: createdAt,
  };
}

export type ActionResult<T = CadRunState> =
  | { ok: true; state: T; events: Array<{ type: string; data?: unknown }> }
  | { ok: false; reason: string };

export function route(
  state: CadRunState | null,
  workflow: CadWorkflow,
  reason: string,
): ActionResult {
  if (state && state.phase !== "intake") {
    return { ok: false, reason: `cad_route is only valid from intake; current phase is ${state.phase}` };
  }
  if (!ALL_WORKFLOWS.includes(workflow)) {
    return { ok: false, reason: `unsupported workflow: ${workflow}` };
  }
  if (!reason.trim()) return { ok: false, reason: "cad_route requires a routing reason" };
  const base = state ?? createIntakeState();
  const next: CadRunState = {
    ...base,
    workflow,
    phase: "requirements",
    status: "active",
    mutationPolicy: "read_only",
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      ...(state ? [] : [{ type: "CadStarted", data: { runId: next.runId } }]),
      { type: "WorkflowRouted", data: { workflow, reason } },
    ],
  };
}

export function commitRequirements(
  state: CadRunState,
  record: CadRequirements,
): ActionResult {
  if (state.phase !== "requirements") {
    return { ok: false, reason: `cad_commit_requirements is only valid in requirements; current phase is ${state.phase}` };
  }
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "workflow is not routed" };
  if (!record.goal.trim()) return { ok: false, reason: "requirements.goal is required" };
  if (!Array.isArray(record.deliverables) || record.deliverables.length === 0) {
    return { ok: false, reason: "requirements.deliverables must contain at least one deliverable" };
  }
  const nextPhase = spec.nextAfterRequirements;
  const next: CadRunState = {
    ...state,
    phase: nextPhase,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(nextPhase, state.workflow ?? undefined),
    requirementsVersion: hashRecord(record),
    maturity: record.maturity,
    evidenceObligations: record.evidenceObligations ?? state.evidenceObligations,
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "RequirementsCommitted", data: { record, phase: nextPhase } }],
  };
}

export function commitPlan(state: CadRunState, record: CadPlan): ActionResult {
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "workflow is not routed" };
  const moveTo = spec.planNext[state.phase];
  const canStay = spec.planStayPhases.includes(state.phase);
  if (!moveTo && !canStay) {
    return { ok: false, reason: `cad_commit_plan is not valid in phase ${state.phase}` };
  }
  if (!record.summary.trim()) return { ok: false, reason: "plan.summary is required" };
  const nextPhase = moveTo ?? state.phase;
  const next: CadRunState = {
    ...state,
    phase: nextPhase,
    mutationPolicy: mutationPolicyForPhase(nextPhase, state.workflow ?? undefined),
    planVersion: hashRecord(record),
    evidenceObligations: record.evidenceObligations ?? state.evidenceObligations,
    workstreamStatuses: record.workstreams?.length
      ? Object.fromEntries(record.workstreams.map((w) => [w.name, w.status]))
      : state.workstreamStatuses,
    activeWorkstreams: record.workstreams?.length
      ? record.workstreams.map((w) => w.name)
      : state.activeWorkstreams,
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "PlanCommitted", data: { record, phase: nextPhase } }],
  };
}

export interface CandidateReceipt {
  label: string;
  sources: string[];
  sourceHashes: Record<string, string>;
  sourcePath: string;
  artifactPath: string;
}

export function acceptCandidate(
  state: CadRunState,
  receipt: CandidateReceipt,
  artifactHash: string,
): ActionResult {
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "workflow is not routed" };
  if (!spec.sourcePhases.includes(state.phase)) {
    return { ok: false, reason: `cad_commit_candidate is only valid in ${spec.sourcePhases.join("/")}; current phase is ${state.phase}` };
  }
  if (!receipt.label.trim() || receipt.sources.length === 0) {
    return { ok: false, reason: "candidate label and at least one source are required" };
  }
  const next: CadRunState = {
    ...state,
    phase: spec.candidateReviewPhase,
    status: "active",
    mutationPolicy: "read_only",
    candidateLabel: receipt.label,
    currentSourcePath: receipt.sourcePath,
    currentSourceHash: receipt.sourceHashes[receipt.sources[0]],
    currentArtifactPath: receipt.artifactPath,
    currentArtifactHash: artifactHash,
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "CandidateCommitted", data: { ...receipt, artifactHash, phase: next.phase } }],
  };
}

export function markEvidenceStale(state: CadRunState): CadRunState {
  return {
    ...state,
    staleEvidence: [...state.staleEvidence, ...state.evidence],
    evidence: [],
    updatedAt: nowIso(),
  };
}

export function addEvidence(
  state: CadRunState,
  evidence: EvidenceRef,
): CadRunState {
  return { ...state, evidence: [...state.evidence, evidence], updatedAt: nowIso() };
}

export function evidenceForArtifact(
  state: CadRunState,
  artifactHash: string,
  kind: EvidenceRef["kind"],
): EvidenceRef[] {
  return state.evidence.filter(
    (ref) => ref.artifactHash === artifactHash && ref.kind === kind && !state.staleEvidence.includes(ref),
  );
}

export function hasEvidenceForArtifact(
  state: CadRunState,
  artifactHash: string | undefined,
  kind: EvidenceRef["kind"],
): boolean {
  return Boolean(artifactHash && evidenceForArtifact(state, artifactHash, kind).length > 0);
}

export function hasCurrentEvidence(state: CadRunState, kind: EvidenceRef["kind"]): boolean {
  return hasEvidenceForArtifact(state, state.currentArtifactHash, kind);
}

export function evidenceFromBuild(
  envelope: { artifacts: Array<{ path: string; kind: string; sha256: string }>; tool?: string },
  artifactHash: string,
  sourceHash: string,
): EvidenceRef {
  return {
    id: makeEvidenceId("build", artifactHash),
    kind: "build",
    tool: "cad_build_step",
    artifactHash,
    sourceHash,
    paths: envelope.artifacts.map((artifact) => artifact.path),
    artifacts: envelope.artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    createdAt: nowIso(),
  };
}

export function evidenceFromEnvelope(
  kind: EvidenceRef["kind"],
  tool: string,
  envelope: {
    artifacts: Array<{ path: string; kind: string; sha256: string }>;
    inputArtifacts?: EvidenceInputArtifact[];
  },
  artifactHash: string,
  sourceHash?: string,
  specHash?: string,
  caseId?: string,
): EvidenceRef {
  const inputArtifacts = (envelope as { inputArtifacts?: EvidenceInputArtifact[] }).inputArtifacts;
  return {
    id: makeEvidenceId(kind, artifactHash, specHash, caseId),
    kind,
    tool,
    artifactHash,
    sourceHash,
    specHash,
    caseId,
    paths: envelope.artifacts.map((artifact) => artifact.path),
    artifacts: envelope.artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    ...(inputArtifacts?.length ? { inputArtifacts } : {}),
    createdAt: nowIso(),
  };
}

export function transitionTarget(
  state: CadRunState,
  event: string,
): CadPhase | null {
  const spec = workflowSpec(state);
  if (!spec) return null;
  return spec.transitions[state.phase]?.[event] ?? null;
}

export function transition(
  state: CadRunState,
  event: string,
  note: string,
): ActionResult {
  if (!note.trim() && event !== "accepted") {
    return { ok: false, reason: "cad_transition requires a note" };
  }
  if (state.phase === "requirements") {
    return { ok: false, reason: `transition ${event} is not valid in phase ${state.phase}` };
  }
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "workflow is not routed" };

  if (event === "accepted" && spec.acceptedPhases.includes(state.phase)) {
    if (!state.currentArtifactHash) {
      return { ok: false, reason: "cannot accept: no current artifact is bound" };
    }
    for (const kind of spec.acceptedEvidence(state)) {
      if (!hasCurrentEvidence(state, kind)) {
        return { ok: false, reason: `cannot accept: current ${kind} evidence is missing` };
      }
    }
    if (state.evidenceObligations?.simulation?.disposition === "required") {
      if (!hasCurrentEvidence(state, "simulation")) {
        return { ok: false, reason: "cannot accept: required simulation evidence is missing for the current artifact" };
      }
      const caseFailure = caseObligationFailure(state, state.currentArtifactHash, "cannot accept");
      if (caseFailure) return { ok: false, reason: caseFailure };
    }
    const guard = spec.completionGuard?.(state);
    if (guard) return { ok: false, reason: `cannot accept: ${guard}` };
    const next: CadRunState = {
      ...state,
      phase: "ready",
      status: "ready",
      mutationPolicy: "read_only",
      updatedAt: nowIso(),
    };
    return { ok: true, state: next, events: [{ type: "WorkflowReady", data: { event, note } }] };
  }

  if (event === "baseline_understood" && (state.phase === "baseline" || state.phase === "source_baseline")) {
    if (spec.requiresBaselineInput && !state.baselineArtifactHash) {
      return { ok: false, reason: "cannot leave baseline: no baseline artifact is bound" };
    }
    if (spec.baselineEvidenceRequired && state.baselineArtifactHash) {
      if (!hasEvidenceForArtifact(state, state.baselineArtifactHash, "visual")) {
        return { ok: false, reason: "cannot leave baseline: current baseline visual evidence is missing" };
      }
      if (!hasEvidenceForArtifact(state, state.baselineArtifactHash, "geometry")) {
        return { ok: false, reason: "cannot leave baseline: current baseline geometry evidence is missing" };
      }
    }
  }

  if (
    event === "findings_delivered" &&
    state.workflow === "analyze" &&
    state.evidenceObligations?.simulation?.disposition === "required" &&
    state.baselineArtifactHash &&
    !hasEvidenceForArtifact(state, state.baselineArtifactHash, "simulation")
  ) {
    return { ok: false, reason: "cannot complete analyze: required simulation evidence is missing for the baseline artifact" };
  }
  if (event === "findings_delivered" && state.workflow === "analyze" && state.baselineArtifactHash) {
    const caseFailure = caseObligationFailure(state, state.baselineArtifactHash, "cannot complete analyze");
    if (caseFailure) return { ok: false, reason: caseFailure };
  }
  const target = transitionTarget(state, event);
  if (!target) {
    return { ok: false, reason: `transition ${event} is not valid in phase ${state.phase} for workflow ${state.workflow ?? "unset"}` };
  }
  const next: CadRunState = {
    ...state,
    phase: target,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(target, state.workflow ?? undefined),
    updatedAt: nowIso(),
  };
  return { ok: true, state: next, events: [{ type: "TransitionRequested", data: { event, note, to: target } }] };
}

export function waitForUser(state: CadRunState, reason: string): ActionResult {
  if (state.phase === "done") return { ok: false, reason: "workflow is already done" };
  if (!reason.trim()) return { ok: false, reason: "cad_wait_for_user requires a reason" };
  const next: CadRunState = { ...state, status: "waiting_user", updatedAt: nowIso() };
  return {
    ok: true,
    state: next,
    events: [{ type: "UserInputRequested", data: { phase: state.phase, reason } }],
  };
}

export function resumeFromUser(state: CadRunState): CadRunState {
  if (state.status !== "waiting_user") return state;
  return { ...state, status: "active", updatedAt: nowIso() };
}

export function finish(state: CadRunState): ActionResult {
  if (state.phase !== "ready") {
    return { ok: false, reason: `cad_finish is only valid in ready; current phase is ${state.phase}` };
  }
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "workflow is not routed" };
  if (state.workflow === "analyze") {
    if (!state.baselineArtifactHash) {
      return { ok: false, reason: "cad_finish requires a bound baseline artifact for analyze workflow" };
    }
    if (
      state.evidenceObligations?.simulation?.disposition === "required" &&
      !hasEvidenceForArtifact(state, state.baselineArtifactHash, "simulation")
    ) {
      return { ok: false, reason: "cad_finish requires required simulation evidence for the baseline artifact" };
    }
    const baselineCaseFailure = caseObligationFailure(state, state.baselineArtifactHash, "cad_finish blocked");
    if (baselineCaseFailure) return { ok: false, reason: baselineCaseFailure };
  } else {
    if (!state.currentSourceHash || !state.currentArtifactHash) {
      return { ok: false, reason: "cad_finish requires current source and artifact hashes" };
    }
    for (const kind of spec.finishEvidence(state)) {
      if (!hasCurrentEvidence(state, kind)) {
        return { ok: false, reason: `cad_finish requires current ${kind} evidence` };
      }
    }
    if (state.evidenceObligations?.simulation?.disposition === "required") {
      if (!hasCurrentEvidence(state, "simulation")) {
        return { ok: false, reason: "cad_finish requires required simulation evidence for the current artifact" };
      }
      const caseFailure = caseObligationFailure(state, state.currentArtifactHash, "cad_finish blocked");
      if (caseFailure) return { ok: false, reason: caseFailure };
    }
  }
  const completionGuard = spec.completionGuard?.(state);
  if (completionGuard) return { ok: false, reason: completionGuard };
  const next: CadRunState = {
    ...state,
    phase: "done",
    status: "done",
    mutationPolicy: "read_only",
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "Finished", data: { runId: state.runId } }],
  };
}
