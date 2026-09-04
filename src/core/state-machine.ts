import {
  CAD_STATE_SCHEMA_VERSION,
  type AcceptanceAssertion,
  type CadPhase,
  type CadPlan,
  type CadRequirements,
  type RequirementsRevisionDiff,
  type CadRunState,
  type EvidenceInputArtifact,
  type EvidenceRef,
  type DeferredClarification,
  type InteractionMode,
  type MutationPolicy,
  type Route,
  isRoute,
  obligationsOf,
  recordObligations,
  routeKey,
  MATURITY_RANK,
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
  interactionMode?: InteractionMode;
}

export function createIntakeState(options: CreateIntakeOptions = {}): CadRunState {
  const createdAt = nowIso();
  return {
    schemaVersion: CAD_STATE_SCHEMA_VERSION,
    runId:
      options.runId ??
      `run-${createdAt.slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: options.projectId ?? "project",
    createdAt,
    interactionMode: options.interactionMode ?? "interactive",
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
  const validationFailure = validateRequirementsRecord(state, record);
  if (validationFailure) return { ok: false, reason: validationFailure };
  const spec = workflowSpec(state)!;
  const nextPhase = spec.nextAfterRequirements;
  const next: CadRunState = {
    ...state,
    phase: nextPhase,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(nextPhase, state.route),
    requirementsVersion: hashRecord(record),
    assertionsVersion: hashRecord(record.assertions),
    finalReview: undefined,
    deferredClarifications: [
      ...(state.deferredClarifications ?? []).filter((item) => item.phase !== "requirements"),
      ...(record.deferredClarifications ?? []).map((item) => ({
        phase: "requirements" as const,
        ...item,
        affectsContract: true,
        createdAt: nowIso(),
      })),
    ],
    evidenceObligations: record.evidenceObligations ?? state.evidenceObligations,
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      { type: "RequirementsCommitted", data: { record, phase: nextPhase } },
      ...(record.deferredClarifications ?? []).map((clarification) => ({
        type: "HeadlessClarificationDeferred",
        data: { phase: state.phase, ...clarification },
      })),
    ],
  };
}

const REQUIREMENTS_ARRAY_FIELDS = [
  "deliverables",
  "must",
  "preferences",
  "assumptions",
  "openUnknowns",
  "inputs",
] as const;

function counted(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function arrayDifference(before: string[], after: string[]) {
  const beforeCounts = counted(before);
  const afterCounts = counted(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [value, count] of afterCounts) {
    for (let i = beforeCounts.get(value) ?? 0; i < count; i += 1) added.push(value);
  }
  for (const [value, count] of beforeCounts) {
    for (let i = afterCounts.get(value) ?? 0; i < count; i += 1) removed.push(value);
  }
  const commonTokens = (values: string[], limits: Map<string, number>) => {
    const seen = new Map<string, number>();
    return values.flatMap((value) => {
      const occurrence = (seen.get(value) ?? 0) + 1;
      seen.set(value, occurrence);
      return occurrence <= (limits.get(value) ?? 0) ? [`${value}\u0000${occurrence}`] : [];
    });
  };
  const commonLimits = new Map<string, number>();
  for (const [value, count] of beforeCounts) {
    commonLimits.set(value, Math.min(count, afterCounts.get(value) ?? 0));
  }
  const orderChanged = hashRecord(commonTokens(before, commonLimits)) !== hashRecord(commonTokens(after, commonLimits));
  const sequenceChanged = hashRecord(before) !== hashRecord(after);
  return {
    added,
    removed,
    orderChanged,
    ...(sequenceChanged ? { before, after } : {}),
  };
}

export function diffRequirements(
  before: CadRequirements,
  after: CadRequirements,
): RequirementsRevisionDiff {
  const arrays: RequirementsRevisionDiff["arrays"] = {};
  for (const field of REQUIREMENTS_ARRAY_FIELDS) {
    const diff = arrayDifference(before[field] ?? [], after[field] ?? []);
    if (diff.added.length || diff.removed.length || diff.orderChanged || diff.before) arrays[field] = diff;
  }

  const beforeAssertions = new Map(before.assertions.map((item) => [item.id, item]));
  const afterAssertions = new Map(after.assertions.map((item) => [item.id, item]));
  const beforeAssertionIds = before.assertions.map((item) => item.id);
  const afterAssertionIds = after.assertions.map((item) => item.id);
  const assertionOrder = arrayDifference(beforeAssertionIds, afterAssertionIds);
  const assertions = {
    added: [...afterAssertions.keys()].filter((id) => !beforeAssertions.has(id)),
    removed: [...beforeAssertions.keys()].filter((id) => !afterAssertions.has(id)),
    changed: [...afterAssertions.keys()].filter((id) =>
      beforeAssertions.has(id) && hashRecord(beforeAssertions.get(id)) !== hashRecord(afterAssertions.get(id))),
    orderChanged: assertionOrder.orderChanged,
    ...(assertionOrder.before ? { before: beforeAssertionIds, after: afterAssertionIds } : {}),
  };
  const fields: RequirementsRevisionDiff["fields"] = [];
  for (const field of ["goal", "evidenceObligations", "deferredClarifications"] as const) {
    if (hashRecord(before[field]) !== hashRecord(after[field])) {
      fields.push({ field, before: before[field], after: after[field] });
    }
  }
  const diff = { arrays, assertions, fields };
  if (
    hashRecord(before) !== hashRecord(after) &&
    Object.keys(arrays).length === 0 &&
    assertions.added.length === 0 && assertions.removed.length === 0 && assertions.changed.length === 0 &&
    !assertions.orderChanged && !assertions.before &&
    fields.length === 0
  ) {
    fields.push({ field: "record", before, after });
  }
  return diff;
}

const REVISION_RECORD_PHASE_ORDER: CadPhase[] = ["assembly_design", "interface_design"];

export function earliestPhaseAfterRequirementsRevision(
  state: CadRunState,
  nextRoute: Route = state.route!,
): CadPhase {
  const spec = compiledSpec(nextRoute);
  if (spec.requiresBaselineInput) {
    return spec.nextAfterRequirements === "source_baseline" ? "source_baseline" : "baseline";
  }
  const committed = new Set(state.phaseRecords ?? []);
  for (const phase of REVISION_RECORD_PHASE_ORDER) {
    if ((spec.phaseRecords[phase] ?? []).some((type) => !committed.has(type))) return phase;
  }
  for (const phase of ["plan", "part_design", "transform_plan"] as CadPhase[]) {
    if (spec.planNext[phase]) return phase;
  }
  return earliestUnmetPhase(state, nextRoute);
}

export interface ReviseRequirementsOptions {
  reason: string;
  routeAssessment: { outcome: "unchanged" | "changed"; reason: string };
  baselineIdentityChanged?: boolean;
  externalBlocker?: { reason: string; needed: string };
}

export function reviseRequirements(
  state: CadRunState,
  previous: CadRequirements,
  record: CadRequirements,
  options: ReviseRequirementsOptions,
): ActionResult {
  if (!state.route || !state.requirementsVersion) return { ok: false, reason: "requirements are not committed" };
  if (!options.reason.trim()) return { ok: false, reason: "cad_revise_requirements requires a reason" };
  if (!options.routeAssessment.reason.trim()) return { ok: false, reason: "routeAssessment.reason is required" };
  const validationFailure = validateRequirementsRecord(
    { ...state, phase: "requirements", mutationPolicy: "read_only" },
    record,
  );
  if (validationFailure) return { ok: false, reason: validationFailure };

  const newVersion = hashRecord(record);
  if (newVersion === state.requirementsVersion) {
    if (!state.routeRequiresReassessment || options.routeAssessment.outcome !== "unchanged") {
      return { ok: false, reason: "requirements revision equals the current version" };
    }
    const nextPhase = earliestPhaseAfterRequirementsRevision(state);
    const next: CadRunState = {
      ...state,
      phase: nextPhase,
      status: options.externalBlocker ? "blocked_external" : "active",
      mutationPolicy: mutationPolicyForPhase(nextPhase, state.route),
      routeRequiresReassessment: false,
      blocker: options.externalBlocker
        ? { type: "external_input", ...options.externalBlocker, createdAt: nowIso() }
        : undefined,
      lastRequirementsRevision: state.lastRequirementsRevision
        ? {
            ...state.lastRequirementsRevision,
            routeAssessment: "unchanged",
            routeAssessmentReason: options.routeAssessment.reason,
          }
        : undefined,
      updatedAt: nowIso(),
    };
    return {
      ok: true,
      state: next,
      events: [{
        type: "RouteReassessmentConfirmed",
        data: { requirementsVersion: newVersion, reason: options.routeAssessment.reason, phase: nextPhase },
      }],
    };
  }

  const at = nowIso();
  const staleById = new Map(state.staleEvidence.map((item) => [item.id, item]));
  for (const item of state.evidence) staleById.set(item.id, item);
  const phaseRecords = (state.phaseRecords ?? []).filter((type) =>
    type !== "assembly_design" && type !== "interface_contracts" &&
    !(options.baselineIdentityChanged && type === "frame_context"));
  const revision = {
    previousVersion: state.requirementsVersion,
    currentVersion: newVersion,
    supersedesVersion: state.requirementsVersion,
    reason: options.reason,
    routeAssessment: options.routeAssessment.outcome,
    routeAssessmentReason: options.routeAssessment.reason,
    diff: diffRequirements(previous, record),
    at,
  } as const;
  const invalidated: CadRunState = {
    ...state,
    status: options.externalBlocker ? "blocked_external" : "active",
    mutationPolicy: "read_only",
    requirementsVersion: newVersion,
    assertionsVersion: hashRecord(record.assertions),
    planVersion: undefined,
    finalReview: undefined,
    workstreamStatuses: undefined,
    activeWorkstreams: [],
    deferredClarifications: (record.deferredClarifications ?? []).map((item) => ({
      phase: "requirements" as const,
      ...item,
      affectsContract: true,
      createdAt: at,
    })),
    evidenceObligations: record.evidenceObligations,
    evidence: [],
    staleEvidence: [...staleById.values()],
    phaseRecords,
    pendingReroute: null,
    rerouteAuthorityToken: null,
    rerouteAuthorityRoute: null,
    blocker: options.externalBlocker
      ? { type: "external_input", ...options.externalBlocker, createdAt: at }
      : undefined,
    routeRequiresReassessment: options.routeAssessment.outcome === "changed",
    lastRequirementsRevision: revision,
    updatedAt: at,
  };
  const nextPhase = options.routeAssessment.outcome === "unchanged"
    ? earliestPhaseAfterRequirementsRevision(invalidated)
    : state.phase;
  const next: CadRunState = {
    ...invalidated,
    phase: nextPhase,
    mutationPolicy: options.routeAssessment.outcome === "changed"
      ? "read_only"
      : mutationPolicyForPhase(nextPhase, state.route),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "RequirementsRevised", data: { record, ...revision, phase: nextPhase } }],
  };
}

/**
 * Pure validation used both for the first commit and before a later record is
 * allowed to enter the immutable-contract authorization path. Invalid tool
 * payloads must never become pending revisions or block a headless run.
 */
export function validateRequirementsRecord(
  state: CadRunState,
  record: CadRequirements,
): string | null {
  const spec = workflowSpec(state);
  if (!spec) return "route is not selected";
  if (!record.goal?.trim()) return "requirements.goal is required";
  if (!Array.isArray(record.deliverables) || record.deliverables.length === 0) {
    return "requirements.deliverables must contain at least one deliverable";
  }
  if (record.deliverables.some((item) => typeof item !== "string" || !item.trim())) {
    return "requirements.deliverables may not contain empty entries";
  }
  for (const field of ["must", "assertions", "preferences", "assumptions", "openUnknowns"] as const) {
    if (!Array.isArray(record[field])) return `requirements.${field} is required`;
  }
  for (const [index, item] of (record.deferredClarifications ?? []).entries()) {
    if (!item.question?.trim() || !item.reason?.trim() || !item.fallback?.trim() || !item.impact?.trim()) {
      return `deferredClarifications[${index}] requires question, reason, fallback, and impact`;
    }
    if (!Array.isArray(item.alternatives) || item.alternatives.filter((value) => value.trim()).length < 2) {
      return `deferredClarifications[${index}] requires at least two alternatives`;
    }
    if (!Array.isArray(record.assumptions) || !record.assumptions.some((assumption) => assumption.includes(item.fallback))) {
      return `deferredClarifications[${index}] fallback must also be recorded verbatim in assumptions[]`;
    }
  }
  const assertionFailure = validateAcceptanceAssertions(record.must, record.assertions);
  return assertionFailure ?? null;
}

/**
 * Assertions are a pre-registered contract, not an author-written review
 * note. Every Must must be represented before implementation begins, while
 * multiple assertions may legitimately decompose one compound Must.
 */
export function validateAcceptanceAssertions(
  must: string[],
  assertions: AcceptanceAssertion[] | undefined,
): string | null {
  if (!Array.isArray(assertions)) {
    return "requirements.assertions is required and must be committed before implementation";
  }
  if (must.length > 0 && assertions.length === 0) {
    return "requirements.assertions must cover every Must before implementation";
  }
  const expectedRefs = new Set(must.map((_, index) => `M${index + 1}`));
  const covered = new Set<string>();
  const ids = new Set<string>();
  for (const assertion of assertions) {
    if (!assertion.id?.trim()) return "every assertion requires a stable id";
    if (ids.has(assertion.id)) return `duplicate assertion id: ${assertion.id}`;
    ids.add(assertion.id);
    if (!expectedRefs.has(assertion.mustRef)) {
      return `assertion ${assertion.id} has unknown mustRef ${assertion.mustRef}; expected M1..M${must.length}`;
    }
    covered.add(assertion.mustRef);
    if (!assertion.statement?.trim()) return `assertion ${assertion.id} requires a statement`;
    if (!assertion.binding?.subject?.trim() || !assertion.binding?.quantity?.trim()) {
      return `assertion ${assertion.id} requires binding.subject and binding.quantity`;
    }
    if (assertion.expectation?.kind === "range") {
      const { min, max } = assertion.expectation;
      if (min === undefined && max === undefined) {
        return `assertion ${assertion.id} range requires min and/or max`;
      }
      if (min !== undefined && max !== undefined && min > max) {
        return `assertion ${assertion.id} range min cannot exceed max`;
      }
    }
    if (assertion.expectation?.kind === "relation" && !assertion.expectation.description.trim()) {
      return `assertion ${assertion.id} relation requires a description`;
    }
    const direction = assertion.binding.direction?.trim().toLowerCase();
    const normalizedDirection = direction
      ?.replace(/\bglobal\b/g, "")
      .replace(/\baxis\b/g, "")
      .replace(/\s+/g, "");
    const directionalField = normalizedDirection === "x" || normalizedDirection === "+x" || normalizedDirection === "-x"
      ? "bbox.x"
      : normalizedDirection === "y" || normalizedDirection === "+y" || normalizedDirection === "-y"
        ? "bbox.y"
        : normalizedDirection === "z" || normalizedDirection === "+z" || normalizedDirection === "-z"
          ? "bbox.z"
          : null;
    if (
      directionalField &&
      (assertion.expectation?.kind === "exact" || assertion.expectation?.kind === "range") &&
      !assertion.canonicalCheck
    ) {
      return `assertion ${assertion.id} explicitly binds global ${directionalField.slice(-1).toUpperCase()} but omits canonicalCheck ${directionalField}`;
    }
    if (
      directionalField &&
      assertion.canonicalCheck?.field.startsWith("bbox.") &&
      assertion.canonicalCheck.field !== directionalField
    ) {
      return `assertion ${assertion.id} binds global ${directionalField.slice(-1).toUpperCase()} but canonicalCheck uses ${assertion.canonicalCheck.field}`;
    }
  }
  const missing = [...expectedRefs].filter((ref) => !covered.has(ref));
  return missing.length > 0 ? `requirements.assertions missing Must coverage: ${missing.join(", ")}` : null;
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

/**
 * Commit a phase record (frame context, assembly design, interface
 * contracts...). The record commit IS the transition wherever the compiled
 * process declares an event for it (assembly chain); otherwise the record
 * is committed in place (frame context in baseline, records in audit).
 *
 * There is no cad_transition escape: record events are rejected by the
 * generic transition path, so the record trail cannot be bypassed or
 * replayed.
 */
export function commitPhaseRecord(
  state: CadRunState,
  recordType: string,
  record: unknown,
): ActionResult {
  const spec = workflowSpec(state);
  if (!spec) return { ok: false, reason: "route is not selected" };
  const owed = spec.phaseRecords[state.phase] ?? [];
  if (!owed.includes(recordType)) {
    return { ok: false, reason: `phase ${state.phase} owes no ${recordType} record for this route (owed: ${owed.join(", ") || "none"})` };
  }
  const event = recordEventFor(recordType);
  // No declared transition for this record event means "commit and stay".
  const target = (event && spec.transitions[state.phase]?.[event]) || state.phase;
  const stale = spec.recordStaleOnEnter?.[target] ?? [];
  const keptRecords = (state.phaseRecords ?? []).filter((r) => !stale.includes(r));
  const next: CadRunState = {
    ...state,
    ...(target !== state.phase
      ? {
          phase: target,
          status: "active" as const,
          mutationPolicy: mutationPolicyForPhase(target, state.route),
        }
      : {}),
    phaseRecords: [...new Set([...keptRecords, recordType])],
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      { type: "PhaseRecordCommitted", data: { recordType, record, phase: target } },
      ...(stale.length ? [{ type: "PhaseRecordsStaled", data: { entering: target, staled: stale } }] : []),
    ],
  };
}

/** Deterministic event name for a record type, when the process has one. */
function recordEventFor(recordType: string): string | null {
  if (recordType === "assembly_design") return "assembly_design_committed";
  if (recordType === "interface_contracts") return "interface_contracts_committed";
  return null;
}

/** All record-commit event names (cad_transition must reject these). */
const RECORD_EVENT_NAMES = new Set([
  "assembly_design_committed",
  "interface_contracts_committed",
  "frame_context_committed",
]);

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
  // Release processes have two candidate loops: design sources land in the
  // design review, gap_closure lands in audit.
  const reviewPhase = spec.sourcePhaseReviews?.[state.phase] ?? spec.candidateReviewPhase;
  const next: CadRunState = {
    ...state,
    phase: reviewPhase,
    status: "active",
    mutationPolicy: "read_only",
    candidateLabel: receipt.label,
    currentSourcePath: receipt.sourcePath,
    currentSourceHash: receipt.sourceHashes[receipt.sources[0]],
    currentArtifactPath: receipt.artifactPath,
    currentArtifactHash: artifactHash,
    finalReview: undefined,
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
    finalReview: undefined,
    updatedAt: nowIso(),
  };
}

export function addEvidence(
  state: CadRunState,
  evidence: EvidenceRef,
): CadRunState {
  return { ...state, evidence: [...state.evidence, evidence], finalReview: undefined, updatedAt: nowIso() };
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
  envelope: {
    artifacts: Array<{ path: string; kind: string; sha256: string }>;
    inputArtifacts?: EvidenceInputArtifact[];
    tool?: string;
  },
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
    ...(envelope.inputArtifacts?.length ? { inputArtifacts: envelope.inputArtifacts } : {}),
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

  // Record-commit events are ONLY fired by their commit tools. Allowing
  // cad_transition to replay them would let a stale record trail (after a
  // review regression) skip re-committing the record.
  if (RECORD_EVENT_NAMES.has(event)) {
    return {
      ok: false,
      reason: `transition ${event} is not valid: record commits happen only through their cad_commit_* tool`,
    };
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
    // The transition table is authoritative for where acceptance leads:
    // "ready" closes the run; any other target (audit, when a release
    // suffix follows the design core) continues the process.
    const acceptedTarget = spec.transitions[state.phase]?.accepted ?? "ready";
    const next: CadRunState = {
      ...state,
      phase: acceptedTarget,
      status: acceptedTarget === "ready" ? "ready" : "active",
      mutationPolicy: "read_only",
      updatedAt: nowIso(),
    };
    return {
      ok: true,
      state: next,
      events: [
        acceptedTarget === "ready"
          ? { type: "WorkflowReady", data: { event, note } }
          : { type: "TransitionRequested", data: { event, note, to: acceptedTarget } },
      ],
    };
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
  // Leaving a phase requires the records that phase owes (e.g. the frame
  // context before baseline_understood). The record commit tools satisfy
  // this by adding the record in the same action.
  const owedHere = spec.phaseRecords[state.phase] ?? [];
  const committed = new Set(state.phaseRecords ?? []);
  const unmetHere = owedHere.filter((recordType) => !committed.has(recordType));
  if (unmetHere.length && target !== state.phase) {
    return {
      ok: false,
      reason: `cannot leave ${state.phase}: phase records missing (${unmetHere.join(", ")})`,
    };
  }
  if (SOURCE_PHASES.has(target)) {
    const missing = missingRecordObligations(state);
    if (missing.length) {
      return { ok: false, reason: `cannot enter ${target}: phase records missing (${missing.join(", ")})` };
    }
  }
  // Entering a phase stales the records it declares: review regressions
  // invalidate the downstream record trail so it cannot be reused.
  const stale = spec.recordStaleOnEnter?.[target] ?? [];
  const keptRecords = (state.phaseRecords ?? []).filter((r) => !stale.includes(r));
  const next: CadRunState = {
    ...state,
    phase: target,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(target, state.route),
    ...(stale.length ? { phaseRecords: keptRecords } : {}),
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      { type: "TransitionRequested", data: { event, note, to: target } },
      ...(stale.length ? [{ type: "PhaseRecordsStaled", data: { entering: target, staled: stale } }] : []),
    ],
  };
}

export function waitForUser(state: CadRunState, reason: string): ActionResult {
  if (state.phase === "done") return { ok: false, reason: "workflow is already done" };
  if (!reason.trim()) return { ok: false, reason: "cad_wait_for_user requires a reason" };
  if (state.interactionMode === "headless") {
    return {
      ok: false,
      reason:
        "headless workflows cannot enter waiting_user; record an engineering fallback with cad_defer_clarification or declare a user-owned blocker",
    };
  }
  const next: CadRunState = { ...state, status: "waiting_user", updatedAt: nowIso() };
  return {
    ok: true,
    state: next,
    events: [{ type: "UserInputRequested", data: { phase: state.phase, reason } }],
  };
}

export function deferClarification(
  state: CadRunState,
  input: Omit<DeferredClarification, "phase" | "createdAt">,
): ActionResult {
  if (state.interactionMode !== "headless") {
    return { ok: false, reason: "cad_defer_clarification is only valid in headless mode" };
  }
  if (!input.question.trim() || !input.reason.trim() || !input.fallback.trim() || !input.impact.trim()) {
    return { ok: false, reason: "clarification requires question, reason, fallback, and impact" };
  }
  if (input.alternatives.filter((item) => item.trim()).length < 2) {
    return { ok: false, reason: "clarification requires at least two alternatives" };
  }
  if (input.affectsContract && state.requirementsVersion) {
    return {
      ok: false,
      reason:
        "the committed requirements contract is immutable; a different contract requires an exact user-issued revision authority token, which headless mode cannot issue",
    };
  }
  const clarification: DeferredClarification = {
    phase: state.phase,
    ...input,
    createdAt: nowIso(),
  };
  const nextPhase = input.affectsContract ? "requirements" : state.phase;
  const next: CadRunState = {
    ...state,
    phase: nextPhase,
    status: "active",
    mutationPolicy: input.affectsContract
      ? "read_only"
      : state.mutationPolicy,
    finalReview: input.affectsContract ? undefined : state.finalReview,
    deferredClarifications: [...(state.deferredClarifications ?? []), clarification],
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      { type: "HeadlessClarificationDeferred", data: clarification },
      ...(input.affectsContract
        ? [{ type: "RequirementsRevisionRequired", data: { from: state.phase, reason: input.reason } }]
        : []),
    ],
  };
}

export function declareHeadlessBlocker(
  state: CadRunState,
  input: { type: "user_authority" | "external_input"; reason: string; needed: string },
): ActionResult {
  if (state.interactionMode !== "headless") {
    return { ok: false, reason: "cad_declare_blocker is only valid in headless mode" };
  }
  if (!input.reason.trim() || !input.needed.trim()) {
    return { ok: false, reason: "headless blocker requires reason and needed" };
  }
  const createdAt = nowIso();
  const status = input.type === "user_authority" ? "blocked_user" : "blocked_external";
  const blocker = { ...input, createdAt };
  return {
    ok: true,
    state: { ...state, status, blocker, updatedAt: createdAt },
    events: [{ type: "HeadlessWorkflowBlocked", data: blocker }],
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

// ---------------------------------------------------------------------------
// Reroute (0.8 M3)
// ---------------------------------------------------------------------------

const RECORD_PHASE_ORDER: CadPhase[] = [
  "baseline",
  "source_baseline",
  "system_concept",
  "assembly_design",
  "interface_design",
  "part_design",
  "audit",
];

/**
 * Where a rerouted run must resume: the earliest phase with an unmet
 * obligation. Reroute never grants progress and never accepts a target
 * phase — the harness derives it from what is missing:
 *
 *   1. baseline not bound (new route requires one)      -> baseline phase
 *   2. record obligations missing                       -> the phase owing
 *      the earliest missing record (frame context in the baseline phase,
 *      assembly_design, interface_design, ...)
 *   3. no current artifact                              -> first source phase
 *   4. review-phase evidence kinds unmet                -> review phase
 *   5. otherwise                                        -> current phase when
 *      it still exists in the new process, else the review phase
 */
export function earliestUnmetPhase(state: CadRunState, nextRoute: Route): CadPhase {
  const spec = compiledSpec(nextRoute);
  if (spec.requiresBaselineInput && !state.baselineArtifactHash) {
    return spec.nextAfterRequirements === "baseline" || spec.nextAfterRequirements === "source_baseline"
      ? spec.nextAfterRequirements
      : "baseline";
  }
  const committed = new Set(state.phaseRecords ?? []);
  const missingRecordPhases = RECORD_PHASE_ORDER.filter(
    (phase) =>
      (spec.phaseRecords[phase] ?? []).some((type) => !committed.has(type)),
  );
  if (missingRecordPhases.length) return missingRecordPhases[0];
  if (!state.currentArtifactHash) return spec.sourcePhases[0] ?? spec.nextAfterRequirements;
  const closurePhase = spec.acceptedPhases.includes("final_review")
    ? "final_review"
    : spec.candidateReviewPhase;
  const unmetEvidence = spec.finishEvidence(state).some((kind) => !hasCurrentEvidence(state, kind));
  if (unmetEvidence) return closurePhase;
  const processPhases: CadPhase[] = [
    ...spec.sourcePhases,
    ...Object.keys(spec.planNext) as CadPhase[],
    ...spec.planStayPhases,
    spec.candidateReviewPhase,
    ...spec.acceptedPhases,
    spec.nextAfterRequirements,
  ];
  return processPhases.includes(state.phase) ? state.phase : closurePhase;
}

export interface RerouteOutcome extends ActionResult {
  /** Set when the reroute needs user authority: the pause to perform. */
  requiresAuthority?: boolean;
}

/**
 * Reroute to a new route mid-process. Autonomous exactly when the new
 * obligation set is a superset of the old one; any obligation drop needs
 * the one-time authority token the harness issued after a real user turn.
 */
export function reroute(
  state: CadRunState,
  nextRoute: Route,
  reason: string,
  token?: string,
): RerouteOutcome {
  if (!state.route) return { ok: false, reason: "route is not selected" };
  if (state.phase === "intake" || state.phase === "ready" || state.phase === "done") {
    return { ok: false, reason: `cad_reroute is not valid in phase ${state.phase}` };
  }
  if (!isRoute(nextRoute)) {
    return { ok: false, reason: "reroute target must be a valid route" };
  }
  if (!reason.trim()) return { ok: false, reason: "cad_reroute requires a reason" };
  if (routeKey(nextRoute) === routeKey(state.route)) {
    return { ok: false, reason: "reroute target equals the current route" };
  }
  const autonomous = rerouteIsAutonomous(state.route, nextRoute);
  let authority: "autonomous" | "user-token";
  if (autonomous) {
    authority = "autonomous";
  } else {
    // The token is issued ONLY by the user running /cad-approve-reroute,
    // and it is bound to the exact pending route: a token granted for one
    // downgrade cannot authorize a different (possibly harsher) one, and
    // an ordinary user reply never issues anything.
    const pendingKey = state.pendingReroute ? routeKey(state.pendingReroute.route) : null;
    const tokenValid =
      Boolean(token) &&
      Boolean(state.rerouteAuthorityToken) &&
      token === state.rerouteAuthorityToken &&
      pendingKey !== null &&
      routeKey(nextRoute) === pendingKey;
    if (!tokenValid) {
      return {
        ok: false,
        requiresAuthority: true,
        reason: pendingKey
          ? `reroute drops obligations and needs explicit user authority for ${pendingKey}: ask the user to run /cad-approve-reroute, then re-run cad_reroute with the issued authorityToken`
          : "reroute drops obligations and needs explicit user authority: record the request with cad_reroute, ask the user to run /cad-approve-reroute, then re-run with the issued authorityToken",
      };
    }
    authority = "user-token";
  }
  const nextPhase = state.routeRequiresReassessment
    ? earliestPhaseAfterRequirementsRevision(state, nextRoute)
    : earliestUnmetPhase(state, nextRoute);
  const next: CadRunState = {
    ...state,
    route: nextRoute,
    phase: nextPhase,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(nextPhase, nextRoute),
    pendingReroute: null,
    rerouteAuthorityToken: null,
    rerouteAuthorityRoute: null,
    routeRequiresReassessment: false,
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      {
        type: "RouteRerouted",
        data: {
          from: routeKey(state.route),
          to: routeKey(nextRoute),
          authority,
          phase: nextPhase,
          reason,
        },
      },
    ],
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
  if (from.objective === "design" && to.objective === "design") {
    return MATURITY_RANK[to.maturity] >= MATURITY_RANK[from.maturity];
  }
  // Objective changes (design -> analyze/convert) always drop the design
  // commitment structure.
  return from.objective === to.objective;
}
