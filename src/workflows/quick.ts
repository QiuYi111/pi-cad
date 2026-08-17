import {
  V0_CAPABILITY_TOOLS,
  V0_CONTROL_TOOLS,
  V0_WORKFLOW,
  type CadEventEnvelope,
  type CadPhase,
  type CadProjectState,
  type CadRequirements,
  type EvidenceRef,
  type MutationPolicy,
} from "../shared/protocol.ts";
import { hashRecord, makeEvidenceId, nowIso } from "../shared/store.ts";

export const QUICK_MUTATION_POLICY: Record<CadPhase, MutationPolicy> = {
  intake: "read_only",
  requirements: "read_only",
  build: "source_only",
  review: "read_only",
  ready: "read_only",
  done: "read_only",
};

const BUILTIN_READONLY = ["read", "grep", "find", "ls"];
const BUILTIN_SOURCE = [...BUILTIN_READONLY, "bash", "edit", "write"];

export function toolsForPhase(phase: CadPhase): string[] {
  switch (phase) {
    case "intake":
      return [...BUILTIN_READONLY, "cad_route"];
    case "requirements":
      return [...BUILTIN_READONLY, "bash", "cad_commit_requirements"];
    case "build":
      return [
        ...BUILTIN_SOURCE,
        ...V0_CAPABILITY_TOOLS,
        "cad_commit_candidate",
        "cad_transition",
      ];
    case "review":
      return [
        ...BUILTIN_READONLY,
        "bash",
        "cad_inspect_visual",
        "cad_inspect_geometry",
        "cad_measure",
        "cad_transition",
      ];
    case "ready":
      return [
        ...BUILTIN_READONLY,
        "bash",
        "cad_inspect_visual",
        "cad_inspect_geometry",
        "cad_measure",
        "cad_finish",
      ];
    case "done":
      return BUILTIN_READONLY;
  }
}

export function createIntakeState(): CadProjectState {
  return {
    schemaVersion: 1,
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

export function routeQuick(
  state: CadProjectState | null,
  workflow: string,
  reason: string,
): ActionResult {
  const started = !state || state.phase === "intake";
  if (!started) {
    return { ok: false, reason: `cad_route is only valid from intake; current phase is ${state?.phase}` };
  }
  if (workflow !== V0_WORKFLOW) {
    return { ok: false, reason: `V0 supports workflow ${V0_WORKFLOW}; got ${workflow}` };
  }
  if (!reason.trim()) {
    return { ok: false, reason: "cad_route requires a routing reason" };
  }
  const base = state ?? createIntakeState();
  const next: CadProjectState = {
    ...base,
    workflow: V0_WORKFLOW,
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

export function commitRequirements(
  state: CadProjectState,
  record: CadRequirements,
): ActionResult {
  if (state.phase !== "requirements") {
    return { ok: false, reason: `cad_commit_requirements is only valid in requirements; current phase is ${state.phase}` };
  }
  if (!record.goal.trim()) {
    return { ok: false, reason: "requirements.goal is required" };
  }
  if (!Array.isArray(record.deliverables) || record.deliverables.length === 0) {
    return { ok: false, reason: "requirements.deliverables must contain at least one deliverable" };
  }
  if (!["review", "concept", "prototype", "engineering", "manufacturing", "release"].includes(record.maturity)) {
    return { ok: false, reason: "requirements.maturity is invalid" };
  }
  const next: CadProjectState = {
    ...state,
    phase: "build",
    mutationPolicy: "source_only",
    requirementsVersion: hashRecord(record),
    updatedAt: nowIso(),
  };
  return {
    ok: true,
    state: next,
    events: [
      {
        type: "RequirementsCommitted",
        data: { requirementsVersion: next.requirementsVersion, record },
      },
    ],
  };
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
  return {
    ...state,
    evidence: [...state.evidence, evidence],
    updatedAt: nowIso(),
  };
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

export function hasCurrentEvidence(
  state: CadProjectState,
  kind: EvidenceRef["kind"],
): boolean {
  return Boolean(
    state.currentArtifactHash &&
      evidenceForArtifact(state, state.currentArtifactHash, kind).length > 0,
  );
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
  if (state.phase !== "build") {
    return { ok: false, reason: `cad_commit_candidate is only valid in build; current phase is ${state.phase}` };
  }
  if (!receipt.label.trim() || receipt.sources.length === 0) {
    return { ok: false, reason: "candidate label and at least one source are required" };
  }
  const next: CadProjectState = {
    ...state,
    phase: "review",
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
    events: [
      {
        type: "CandidateCommitted",
        data: {
          label: receipt.label,
          sources: receipt.sources,
          sourceHashes: receipt.sourceHashes,
          artifactHash,
        },
      },
    ],
  };
}

export function transitionQuick(
  state: CadProjectState,
  event: string,
  note: string,
): ActionResult {
  if (state.phase === "review" && event === "revise") {
    const next: CadProjectState = {
      ...state,
      phase: "build",
      mutationPolicy: "source_only",
      candidateLabel: undefined,
      updatedAt: nowIso(),
    };
    return {
      ok: true,
      state: next,
      events: [{ type: "TransitionRequested", data: { event, note } }],
    };
  }

  if (state.phase === "review" && event === "accepted") {
    if (!state.currentArtifactHash) {
      return { ok: false, reason: "cannot accept: no current artifact is bound" };
    }
    if (!hasCurrentEvidence(state, "visual")) {
      return { ok: false, reason: "cannot accept: current visual evidence is missing" };
    }
    if (!hasCurrentEvidence(state, "geometry")) {
      return { ok: false, reason: "cannot accept: current geometry evidence is missing" };
    }
    const next: CadProjectState = {
      ...state,
      phase: "ready",
      status: "ready",
      mutationPolicy: "read_only",
      updatedAt: nowIso(),
    };
    return {
      ok: true,
      state: next,
      events: [{ type: "WorkflowReady", data: { event, note } }],
    };
  }

  return {
    ok: false,
    reason: `transition ${event} is not valid in phase ${state.phase}`,
  };
}

export function finishQuick(state: CadProjectState): ActionResult {
  if (state.phase !== "ready") {
    return { ok: false, reason: `cad_finish is only valid in ready; current phase is ${state.phase}` };
  }
  if (!state.currentSourceHash || !state.currentArtifactHash) {
    return { ok: false, reason: "cad_finish requires current source and artifact hashes" };
  }
  if (!hasCurrentEvidence(state, "visual") || !hasCurrentEvidence(state, "geometry")) {
    return { ok: false, reason: "cad_finish requires current visual and geometry evidence" };
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

export function evidenceFromBuild(
  envelope: CadEventEnvelope,
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

export function evidenceFromVisual(
  envelope: CadEventEnvelope,
  artifactHash: string,
  sourceHash: string,
): EvidenceRef {
  return {
    id: makeEvidenceId("visual", artifactHash),
    kind: "visual",
    tool: "cad_inspect_visual",
    artifactHash,
    sourceHash,
    paths: envelope.artifacts.map((artifact) => artifact.path),
    createdAt: nowIso(),
  };
}

export function evidenceFromGeometry(
  envelope: CadEventEnvelope,
  artifactHash: string,
  sourceHash: string,
): EvidenceRef {
  return {
    id: makeEvidenceId("geometry", artifactHash),
    kind: "geometry",
    tool: "cad_inspect_geometry",
    artifactHash,
    sourceHash,
    paths: envelope.artifacts.map((artifact) => artifact.path),
    createdAt: nowIso(),
  };
}

export const QUICK_WORKFLOW = {
  name: V0_WORKFLOW,
  states: {
    intake: { id: "intake", transitions: { route: "requirements" } },
    requirements: { id: "requirements", transitions: { commit: "build" } },
    build: { id: "build", transitions: { candidate: "review" } },
    review: {
      id: "review",
      transitions: { revise: "build", accepted: "ready" },
    },
    ready: { id: "ready", transitions: { finish: "done" } },
    done: { id: "done", transitions: {} },
  },
} as const;
