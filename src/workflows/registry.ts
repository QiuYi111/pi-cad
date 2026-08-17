import {
  ALL_WORKFLOWS,
  CAPABILITY_TOOLS,
  type CadPhase,
  type CadPlan,
  type CadProjectState,
  type CadRequirements,
  type CadStatus,
  type CadWorkflow,
  type EvidenceRef,
  type MutationPolicy,
} from "../shared/protocol.ts";
import { hashRecord, makeEvidenceId, nowIso } from "../shared/store.ts";

export const BUILTIN_READONLY = ["read", "grep", "find", "ls"];
export const BUILTIN_SOURCE = [...BUILTIN_READONLY, "bash", "edit", "write"];

const REVIEW_TOOLS = [
  ...BUILTIN_READONLY,
  "bash",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_transition",
];

const COGNITIVE_TOOLS = [
  ...BUILTIN_READONLY,
  "bash",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_transition",
];

const SOURCE_PHASES: CadPhase[] = ["build", "modify", "convert"];
const READ_ONLY_PHASES: CadPhase[] = [
  "intake",
  "requirements",
  "baseline",
  "investigate",
  "explain",
  "plan",
  "concept",
  "domain_analysis",
  "intent",
  "source_baseline",
  "transform_plan",
  "review",
  "compare",
  "audit",
  "gap_closure",
  "final_review",
  "ready",
  "done",
];

export function mutationPolicyForPhase(phase: CadPhase): MutationPolicy {
  if (SOURCE_PHASES.includes(phase)) return "source_only";
  if (phase === "package") return "allowed";
  return "read_only";
}

export function toolsForPhase(phase: CadPhase): string[] {
  switch (phase) {
    case "intake":
      return [...BUILTIN_READONLY, "cad_route"];
    case "requirements":
      return [
        ...BUILTIN_READONLY,
        "bash",
        "cad_commit_requirements",
        "cad_wait_for_user",
      ];
    case "build":
    case "modify":
    case "convert":
      return [
        ...BUILTIN_SOURCE,
        ...CAPABILITY_TOOLS,
        "cad_commit_candidate",
        "cad_transition",
        "cad_wait_for_user",
      ];
    case "review":
    case "compare":
      return [
        ...REVIEW_TOOLS,
        "cad_wait_for_user",
        "cad_commit_plan",
      ];
    case "plan":
    case "intent":
    case "transform_plan":
      return [...COGNITIVE_TOOLS, "cad_commit_plan", "cad_wait_for_user"];
    case "baseline":
    case "source_baseline":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "investigate":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "explain":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "concept":
    case "domain_analysis":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "audit":
    case "gap_closure":
      return [
        ...COGNITIVE_TOOLS,
        ...CAPABILITY_TOOLS,
        "cad_commit_plan",
        "cad_wait_for_user",
      ];
    case "package":
      return [
        ...BUILTIN_READONLY,
        "bash",
        "edit",
        "write",
        ...CAPABILITY_TOOLS,
        "cad_commit_plan",
        "cad_transition",
        "cad_wait_for_user",
      ];
    case "final_review":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "ready":
      return [
        ...BUILTIN_READONLY,
        "bash",
        ...CAPABILITY_TOOLS,
        "cad_finish",
      ];
    case "done":
      return BUILTIN_READONLY;
  }
}

export function createIntakeState(): CadProjectState {
  return {
    schemaVersion: 2,
    taskId: `cad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    workflow: null,
    phase: "intake",
    status: "active",
    maturity: "prototype",
    mutationPolicy: "read_only",
    evidence: [],
    staleEvidence: [],
    activeWorkstreams: [],
    updatedAt: nowIso(),
  };
}

export type ActionResult<T = CadProjectState> =
  | { ok: true; state: T; events: Array<{ type: string; data?: unknown }> }
  | { ok: false; reason: string };

export function route(
  state: CadProjectState | null,
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
  const next: CadProjectState = {
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
      ...(state ? [] : [{ type: "CadStarted", data: { taskId: next.taskId } }]),
      { type: "WorkflowRouted", data: { workflow, reason } },
    ],
  };
}

const REQUIREMENTS_NEXT: Record<CadWorkflow, CadPhase> = {
  quick: "build",
  analyze: "baseline",
  modify: "baseline",
  greenfield: "concept",
  hybrid: "baseline",
  convert: "source_baseline",
  release: "audit",
};

export function commitRequirements(
  state: CadProjectState,
  record: CadRequirements,
): ActionResult {
  if (state.phase !== "requirements") {
    return { ok: false, reason: `cad_commit_requirements is only valid in requirements; current phase is ${state.phase}` };
  }
  if (!state.workflow) return { ok: false, reason: "workflow is not routed" };
  if (!record.goal.trim()) return { ok: false, reason: "requirements.goal is required" };
  if (!Array.isArray(record.deliverables) || record.deliverables.length === 0) {
    return { ok: false, reason: "requirements.deliverables must contain at least one deliverable" };
  }
  const nextPhase = REQUIREMENTS_NEXT[state.workflow];
  const next: CadProjectState = {
    ...state,
    phase: nextPhase,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(nextPhase),
    requirementsVersion: hashRecord(record),
    maturity: record.maturity,
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "RequirementsCommitted", data: { record, phase: nextPhase } }],
  };
}

const PLAN_NEXT: Partial<Record<CadPhase, CadPhase>> = {
  plan: "modify",
  intent: "build",
  transform_plan: "convert",
};

export function commitPlan(state: CadProjectState, record: CadPlan): ActionResult {
  if (!PLAN_NEXT[state.phase] && !["audit", "gap_closure", "package"].includes(state.phase)) {
    return { ok: false, reason: `cad_commit_plan is not valid in phase ${state.phase}` };
  }
  if (!record.summary.trim()) return { ok: false, reason: "plan.summary is required" };
  const moveTo = PLAN_NEXT[state.phase];
  const next: CadProjectState = {
    ...state,
    phase: moveTo ?? state.phase,
    mutationPolicy: mutationPolicyForPhase(moveTo ?? state.phase),
    planVersion: hashRecord(record),
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
    events: [{ type: "PlanCommitted", data: { record, phase: next.phase } }],
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
  state: CadProjectState,
  receipt: CandidateReceipt,
  artifactHash: string,
): ActionResult {
  if (!["build", "modify", "convert"].includes(state.phase)) {
    return { ok: false, reason: `cad_commit_candidate is only valid in a source phase; current phase is ${state.phase}` };
  }
  if (!receipt.label.trim() || receipt.sources.length === 0) {
    return { ok: false, reason: "candidate label and at least one source are required" };
  }
  const nextPhase: CadPhase = state.workflow === "convert" ? "compare" : "review";
  const next: CadProjectState = {
    ...state,
    phase: nextPhase,
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
    events: [{ type: "CandidateCommitted", data: { ...receipt, artifactHash, phase: nextPhase } }],
  };
}

interface TransitionDef {
  from: CadPhase;
  event: string;
  to: CadPhase;
}

export function transitionTarget(state: CadProjectState, event: string): CadPhase | null {
  const wf = state.workflow;
  if (state.phase === "baseline" && event === "baseline_understood") {
    if (wf === "analyze") return "investigate";
    if (wf === "modify") return "plan";
    if (wf === "hybrid") return "concept";
  }
  if (state.phase === "source_baseline" && event === "baseline_understood") {
    return "transform_plan";
  }
  if (state.phase === "review") {
    if (event === "revise" || event === "local_geometry_issue") {
      return wf === "modify" ? "modify" : "build";
    }
    if (event === "intent_issue") return wf === "modify" ? "plan" : "intent";
    if (event === "architecture_issue") return "concept";
    if (event === "accepted") return "ready";
  }
  if (state.phase === "compare" && event === "repair") return "convert";
  if (state.phase === "compare" && event === "accepted") return "ready";
  if (state.phase === "investigate" && event === "more_probe") return "investigate";
  if (state.phase === "investigate" && event === "cause_understood") return "explain";
  if (state.phase === "explain" && event === "findings_delivered") return "ready";
  if (state.phase === "concept" && event === "domain_work_needed") return "domain_analysis";
  if (state.phase === "domain_analysis" && event === "domain_question_answered") return "concept";
  if (state.phase === "concept" && event === "explore_more") return "concept";
  if (state.phase === "concept" && event === "direction_selected") return "intent";
  if (state.phase === "intent" && event === "plan_committed") return "build";
  if (state.phase === "audit" && event === "audit_complete") return "gap_closure";
  if (state.phase === "gap_closure" && event === "engineering_changed") return "audit";
  if ((state.phase === "audit" || state.phase === "gap_closure") && event === "workstreams_structurally_closed") return "package";
  if (state.phase === "package" && event === "package_prepared") return "final_review";
  if (state.phase === "final_review" && event === "artifact_issue") return "package";
  if (state.phase === "final_review" && event === "engineering_issue") return "gap_closure";
  if (state.phase === "final_review" && event === "accepted") return "ready";
  return null;
}

export function markEvidenceStale(state: CadProjectState): CadProjectState {
  return {
    ...state,
    staleEvidence: [...state.staleEvidence, ...state.evidence],
    evidence: [],
    updatedAt: nowIso(),
  };
}

export function addEvidence(
  state: CadProjectState,
  evidence: EvidenceRef,
): CadProjectState {
  return { ...state, evidence: [...state.evidence, evidence], updatedAt: nowIso() };
}

export function evidenceForArtifact(
  state: CadProjectState,
  artifactHash: string,
  kind: EvidenceRef["kind"],
): EvidenceRef[] {
  return state.evidence.filter(
    (ref) => ref.artifactHash === artifactHash && ref.kind === kind && !state.staleEvidence.includes(ref),
  );
}

export function hasEvidenceForArtifact(
  state: CadProjectState,
  artifactHash: string | undefined,
  kind: EvidenceRef["kind"],
): boolean {
  return Boolean(artifactHash && evidenceForArtifact(state, artifactHash, kind).length > 0);
}

export function hasCurrentEvidence(state: CadProjectState, kind: EvidenceRef["kind"]): boolean {
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
    createdAt: nowIso(),
  };
}

export function evidenceFromEnvelope(
  kind: EvidenceRef["kind"],
  tool: string,
  envelope: { artifacts: Array<{ path: string; kind: string; sha256: string }> },
  artifactHash: string,
  sourceHash?: string,
): EvidenceRef {
  return {
    id: makeEvidenceId(kind, artifactHash),
    kind,
    tool,
    artifactHash,
    sourceHash,
    paths: envelope.artifacts.map((artifact) => artifact.path),
    createdAt: nowIso(),
  };
}

const RELEASE_WORKSTREAMS = [
  "design_definition",
  "manufacturing_definition",
  "bom",
  "assembly_service",
  "inspection_acceptance",
  "engineering_analysis",
  "risk_quality",
  "configuration",
  "presentation",
];

export function releaseWorkstreamsClosed(state: CadProjectState): string | null {
  for (const name of RELEASE_WORKSTREAMS) {
    const value = state.workstreamStatuses?.[name];
    if (!value || value === "open") {
      return `release workstream ${name} has no non-open status`;
    }
  }
  return null;
}

function acceptedKindsFor(state: CadProjectState): EvidenceRef["kind"][] {
  if (state.workflow === "modify") return ["visual", "geometry", "compare"];
  if (state.workflow === "convert") {
    const isStep = /\.(step|stp)$/i.test(state.currentArtifactPath ?? "");
    return isStep ? ["visual", "geometry", "compare"] : ["convert"];
  }
  return ["visual", "geometry"];
}

export function transition(
  state: CadProjectState,
  event: string,
  note: string,
): ActionResult {
  if (!note.trim() && event !== "accepted") {
    return { ok: false, reason: "cad_transition requires a note" };
  }

  if (state.phase === "requirements") {
    return { ok: false, reason: `transition ${event} is not valid in phase ${state.phase}` };
  }

  if (event === "accepted" && (state.phase === "review" || state.phase === "compare" || state.phase === "final_review")) {
    if (state.phase !== "final_review") {
      if (!state.currentArtifactHash) return { ok: false, reason: "cannot accept: no current artifact is bound" };
      for (const kind of acceptedKindsFor(state)) {
        if (!hasCurrentEvidence(state, kind)) {
          return { ok: false, reason: `cannot accept: current ${kind} evidence is missing` };
        }
      }
    } else if (state.workflow === "release") {
      const closed = releaseWorkstreamsClosed(state);
      if (closed) return { ok: false, reason: `cannot accept: ${closed}` };
    }
    const next: CadProjectState = {
      ...state,
      phase: "ready",
      status: "ready",
      mutationPolicy: "read_only",
      updatedAt: nowIso(),
    };
    return { ok: true, state: next, events: [{ type: "WorkflowReady", data: { event, note } }] };
  }

  if (event === "baseline_understood" && (state.phase === "baseline" || state.phase === "source_baseline")) {
    if (!state.baselineArtifactHash) {
      return { ok: false, reason: "cannot leave baseline: no baseline artifact is bound" };
    }
    if (!hasEvidenceForArtifact(state, state.baselineArtifactHash, "visual")) {
      return { ok: false, reason: "cannot leave baseline: current baseline visual evidence is missing" };
    }
    if (!hasEvidenceForArtifact(state, state.baselineArtifactHash, "geometry")) {
      return { ok: false, reason: "cannot leave baseline: current baseline geometry evidence is missing" };
    }
  }

  const target = transitionTarget(state, event);
  if (!target) {
    return { ok: false, reason: `transition ${event} is not valid in phase ${state.phase} for workflow ${state.workflow ?? "unset"}` };
  }
  const next: CadProjectState = {
    ...state,
    phase: target,
    status: "active",
    mutationPolicy: mutationPolicyForPhase(target),
    updatedAt: nowIso(),
  };
  return { ok: true, state: next, events: [{ type: "TransitionRequested", data: { event, note, to: target } }] };
}

export function waitForUser(state: CadProjectState, reason: string): ActionResult {
  if (state.phase === "done") return { ok: false, reason: "workflow is already done" };
  if (!reason.trim()) return { ok: false, reason: "cad_wait_for_user requires a reason" };
  const next: CadProjectState = { ...state, status: "waiting_user", updatedAt: nowIso() };
  return {
    ok: true,
    state: next,
    events: [{ type: "UserInputRequested", data: { phase: state.phase, reason } }],
  };
}

export function resumeFromUser(state: CadProjectState): CadProjectState {
  if (state.status !== "waiting_user") return state;
  return { ...state, status: "active", updatedAt: nowIso() };
}

export function finish(state: CadProjectState): ActionResult {
  if (state.phase !== "ready") {
    return { ok: false, reason: `cad_finish is only valid in ready; current phase is ${state.phase}` };
  }
  if (state.workflow === "analyze") {
    if (!state.baselineArtifactHash) {
      return { ok: false, reason: "cad_finish requires a bound baseline artifact for analyze workflow" };
    }
  } else {
    if (!state.currentSourceHash || !state.currentArtifactHash) {
      return { ok: false, reason: "cad_finish requires current source and artifact hashes" };
    }
    for (const kind of acceptedKindsFor(state)) {
      if (!hasCurrentEvidence(state, kind)) {
        return { ok: false, reason: `cad_finish requires current ${kind} evidence` };
      }
    }
  }
  if (state.workflow === "release") {
    const closed = releaseWorkstreamsClosed(state);
    if (closed) return { ok: false, reason: closed };
  }
  const next: CadProjectState = {
    ...state,
    phase: "done",
    status: "done",
    mutationPolicy: "read_only",
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "Finished", data: { taskId: state.taskId } }],
  };
}
