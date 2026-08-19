import {
  type CadPhase,
  type CadPlan,
  type CadRequirements,
  type CadRunState,
  type EvidenceInputArtifact,
  type EvidenceRef,
  type MutationPolicy,
  type Route,
  isRoute,
  obligationsOf,
  recordObligations,
} from "../shared/protocol.ts";
import { hashRecord, makeEvidenceId, nowIso } from "../shared/store.ts";
import { caseObligationFailure } from "./evidence-cases.ts";
import { compiledSpec } from "../workflows/index.ts";
import type { CompiledProcess } from "../workflows/index.ts";

const SOURCE_PHASES = new Set<CadPhase>([
  "build",
  "modify",
  "convert",
  "gap_closure",
]);

export function workflowSpec(state: CadRunState): CompiledProcess | null {
  return state.route ? compiledSpec(state.route) : null;
}

/** Historical alias: processes are compiled from routes now. */
export const processSpec = workflowSpec;

export function mutationPolicyForPhase(
  phase: CadPhase,
  route?: Route | null,
): MutationPolicy {
  const spec = route ? compiledSpec(route) : undefined;
  const override = spec?.mutationPolicies?.[phase];
  if (override) return override;
  if (SOURCE_PHASES.has(phase)) return "source_only";
  return "read_only";
}

/**
 * Route-record obligations not yet satisfied by committed phase records.
 * Used wherever progress would otherwise outrun the record trail: entering
 * a source phase, and committing a candidate.
 */
export function missingRecordObligations(
  state: CadRunState,
): string[] {
  if (!state.route) return [];
  const committed = new Set(state.phaseRecords ?? []);
  return recordObligations(state.route).filter((key) => {
    const type = key.slice("record:".length);
    return !committed.has(type);
  });
}

export interface CreateIntakeOptions {
  runId?: string;
  projectId?: string;
}

export function createIntakeState(options: CreateIntakeOptions = {}): CadRunState {
  const createdAt = nowIso();
  return {
    schemaVersion: 4,
    runId:
      options.runId ??
      `run-${createdAt.slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: options.projectId ?? "project",
    createdAt,
    route: null,
    phase: "intake",
    status: "active",
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

/**
 * Route the task. The Agent supplies the hierarchical description
 * (objective → lineage → structure → maturity in one turn); the harness
 * validates structure and compiles the process. It never judges whether
 * the route is the *right* one for the physics — that is the Agent's call.
 */
export function route(
  state: CadRunState | null,
  nextRoute: Route,
  reason: string,
): ActionResult {
  if (state && state.phase !== "intake") {
    return { ok: false, reason: `cad_route is only valid from intake; current phase is ${state.phase}` };
  }
  if (!isRoute(nextRoute)) {
    return { ok: false, reason: "route must be analyze, convert, or the full design tuple (lineage/structure/maturity)" };
  }
  if (!reason.trim()) return { ok: false, reason: "cad_route requires a routing reason" };
  const base = state ?? createIntakeState();
  const next: CadRunState = {
    ...base,
    route: nextRoute,
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
      { type: "RouteSelected", data: { route: nextRoute, reason } },
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
  if (!spec) return { ok: false, reason: "route is not selected" };
  if (!record.goal.trim()) return { ok: false, reason: "requirements.goal is required" };
  if (!Array.isArray(record.deliverables) || record.deliverables.length === 0) {
    return { ok: false, reason: "requirements.deliverables must contain at least one deliverable" };
  }
  const nextPhase = spec.nextAfterRequirements;
  const next: CadRunState = {
    ...state,
    phase: nextPhase,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(nextPhase, state.route),
    requirementsVersion: hashRecord(record),
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
  if (!spec) return { ok: false, reason: "route is not selected" };
  const moveTo = spec.planNext[state.phase];
  const canStay = spec.planStayPhases.includes(state.phase);
  if (!moveTo && !canStay) {
    return { ok: false, reason: `cad_commit_plan is not valid in phase ${state.phase}` };
  }
  if (!record.summary.trim()) return { ok: false, reason: "plan.summary is required" };
  const nextPhase = moveTo ?? state.phase;
  if (SOURCE_PHASES.has(nextPhase)) {
    const missing = missingRecordObligations(state);
    if (missing.length) {
      return { ok: false, reason: `cannot enter ${nextPhase}: phase records missing (${missing.join(", ")})` };
    }
  }
  const next: CadRunState = {
    ...state,
    phase: nextPhase,
    mutationPolicy: mutationPolicyForPhase(nextPhase, state.route),
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

// ---------------------------------------------------------------------------
// Phase records (assembly structure fragment)
// ---------------------------------------------------------------------------

const RECORD_EVENTS: Record<string, string> = {
  assembly_design: "assembly_design_committed",
  interface_contracts: "interface_contracts_committed",
};

const RECORD_EVENT_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(RECORD_EVENTS).map(([type, event]) => [event, type]),
);

/**
 * Commit a phase record (assembly design / interface contracts). The record
 * commit IS the transition wherever the compiled process declares one for
 * the record event (assembly chain); in release audit the record is
 * committed without moving. There is no cad_transition escape that skips
 * the record trail.
 */
export function commitPhaseRecord(
  state: CadRunState,
  recordType: string,
  record: unknown,
): ActionResult {
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "route is not selected" };
  const event = RECORD_EVENTS[recordType];
  if (!event) return { ok: false, reason: `unknown phase record type: ${recordType}` };
  const owed = spec.phaseRecords[state.phase] ?? [];
  if (!owed.includes(recordType)) {
    return { ok: false, reason: `phase ${state.phase} owes no ${recordType} record for this route (owed: ${owed.join(", ") || "none"})` };
  }
  // No declared transition for this record event means "commit and stay".
  const target = spec.transitions[state.phase]?.[event] ?? state.phase;
  const next: CadRunState = {
    ...state,
    ...(target !== state.phase
      ? {
          phase: target,
          status: "active" as const,
          mutationPolicy: mutationPolicyForPhase(target, state.route),
        }
      : {}),
    phaseRecords: [...new Set([...(state.phaseRecords ?? []), recordType])],
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      { type: "PhaseRecordCommitted", data: { recordType, record, phase: target } },
    ],
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
  if (!spec) return { ok: false, reason: "route is not selected" };
  if (!spec.sourcePhases.includes(state.phase)) {
    return { ok: false, reason: `cad_commit_candidate is only valid in ${spec.sourcePhases.join("/")}; current phase is ${state.phase}` };
  }
  if (!receipt.label.trim() || receipt.sources.length === 0) {
    return { ok: false, reason: "candidate label and at least one source are required" };
  }
  const missing = missingRecordObligations(state);
  if (missing.length) {
    return { ok: false, reason: `cannot commit candidate: phase records missing (${missing.join(", ")})` };
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
    subjectArtifactHash: artifactHash,
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
    // The subject design this evidence is about, named explicitly; the
    // inputs it consumed live in inputArtifacts.
    subjectArtifactHash: artifactHash,
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
  if (!spec) return { ok: false, reason: "route is not selected" };

  // Record events may only be re-fired by cad_transition when the record
  // already exists — otherwise the transition would bypass the record trail.
  const recordType = RECORD_EVENT_TO_TYPE[event];
  if (recordType && !(state.phaseRecords ?? []).includes(recordType)) {
    return { ok: false, reason: `transition ${event} requires the ${recordType} record to be committed first` };
  }

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

  const isAnalyze = state.route?.objective === "analyze";
  if (
    event === "findings_delivered" &&
    isAnalyze &&
    state.evidenceObligations?.simulation?.disposition === "required" &&
    state.baselineArtifactHash &&
    !hasEvidenceForArtifact(state, state.baselineArtifactHash, "simulation")
  ) {
    return { ok: false, reason: "cannot complete analyze: required simulation evidence is missing for the baseline artifact" };
  }
  if (event === "findings_delivered" && isAnalyze && state.baselineArtifactHash) {
    const caseFailure = caseObligationFailure(state, state.baselineArtifactHash, "cannot complete analyze");
    if (caseFailure) return { ok: false, reason: caseFailure };
  }
  const target = transitionTarget(state, event);
  if (!target) {
    return { ok: false, reason: `transition ${event} is not valid in phase ${state.phase} for route ${state.route?.objective ?? "unset"}` };
  }
  if (SOURCE_PHASES.has(target)) {
    const missing = missingRecordObligations(state);
    if (missing.length) {
      return { ok: false, reason: `cannot enter ${target}: phase records missing (${missing.join(", ")})` };
    }
  }
  const next: CadRunState = {
    ...state,
    phase: target,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(target, state.route),
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
  if (!spec) return { ok: false, reason: "route is not selected" };
  if (state.route?.objective === "analyze") {
    if (!state.baselineArtifactHash) {
      return { ok: false, reason: "cad_finish requires a bound baseline artifact for analyze routes" };
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

/**
 * Obligation monotonicity for reroute (0.8 M3): a reroute is autonomous
 * exactly when the old obligation set is a subset of the new one.
 */
export function rerouteIsAutonomous(from: Route, to: Route): boolean {
  const newKeys = obligationsOf(to);
  for (const key of obligationsOf(from)) {
    if (!newKeys.has(key)) return false;
  }
  return true;
}
