/**
 * Workflow Compiler (0.8).
 *
 * Processes are no longer hand-written enums. The compiler derives the
 * executable process from the route by composing:
 *
 *   - objective fragment  (analyze / convert / design)
 *   - lineage fragment    (legacy → baseline → change plan; hybrid →
 *                          baseline → concept; greenfield → no baseline)
 *   - structure fragment  (assembly → system_concept → assembly_design →
 *                          interface_design → part_design → build →
 *                          integration_review; part → part_design → build
 *                          → review — the fast path)
 *   - maturity suffix     (release appends audit → gap_closure → package
 *                          → final_review AFTER the design core; overlays
 *                          never replace the design process)
 *
 * The execution engine (WorkflowSpec / state machine) is unchanged: the
 * compiler is a definition mechanism, not a second engine.
 *
 * SINGLE SOURCE OF TRUTH: record/evidence enforcement (phaseRecords,
 * overlay kinds) is derived from obligationsOf(route) in shared/route.ts.
 * The compiler never maintains its own obligation list — a consistency
 * test pins that every record obligation maps onto the compiled process
 * and every phaseRecord traces back to an obligation.
 */

import type { CadPhase, CadRunState, EvidenceRef } from "../shared/protocol.ts";
import type { CadMaturity, ObligationKey, Route } from "../shared/route.ts";
import type { DesignRoute } from "../shared/route.ts";
import { MATURITY_RANK, obligationsOf, recordObligations, RELEASE_WORKSTREAMS } from "../shared/route.ts";
import type { EvidenceKindsResolver, WorkflowSpec } from "./types.ts";

export interface CompiledProcess extends WorkflowSpec {
  route: Route;
  /** Opaque obligation keys (reroute monotonicity is subset comparison). */
  obligations: ObligationKey[];
  /**
   * Phase → record types owed BY that phase before progress can continue.
   * DERIVED from recordObligations(route): the process enforces exactly
   * what the route owes, never more, never less.
   */
  phaseRecords: Partial<Record<CadPhase, string[]>>;
}

// ---------------------------------------------------------------------------
// Release workstream guard (carried over from the 0.7 release workflow)
// ---------------------------------------------------------------------------

export function releaseCompletionGuard(state: CadRunState): string | null {
  for (const name of RELEASE_WORKSTREAMS) {
    const value = state.workstreamStatuses?.[name];
    if (!value || value === "open") {
      return `release workstream ${name} has no non-open status`;
    }
  }
  return null;
}

const visualGeometry = (): EvidenceRef["kind"][] => ["visual", "geometry"];

const visualGeometryCompare = (): EvidenceRef["kind"][] => [
  "visual",
  "geometry",
  "compare",
];

const releaseClosureEvidence = (state: CadRunState): EvidenceRef["kind"][] =>
  state.baselineArtifactHash &&
  state.currentArtifactHash &&
  state.baselineArtifactHash !== state.currentArtifactHash
    ? ["visual", "geometry", "compare"]
    : ["visual", "geometry"];

// ---------------------------------------------------------------------------
// Objective fragments
// ---------------------------------------------------------------------------

/** Read-only diagnosis; exact 0.7 analyze process. */
function analyzeFragment(): WorkflowSpec {
  return {
    nextAfterRequirements: "baseline",
    sourcePhases: [],
    candidateReviewPhase: "review",
    planNext: {},
    planStayPhases: [],
    transitions: {
      baseline: { baseline_understood: "investigate" },
      investigate: { more_probe: "investigate", cause_understood: "explain" },
      explain: { findings_delivered: "ready" },
    },
    acceptedPhases: [],
    acceptedEvidence: visualGeometry,
    finishEvidence: visualGeometry,
    requiresBaselineInput: true,
    baselineEvidenceRequired: true,
    updatesHeadOnAccept: false,
  };
}

/** Format conversion; exact 0.7 convert process. */
function convertFragment(): WorkflowSpec {
  return {
    nextAfterRequirements: "source_baseline",
    sourcePhases: ["convert"],
    candidateReviewPhase: "compare",
    planNext: { transform_plan: "convert" },
    planStayPhases: [],
    transitions: {
      source_baseline: { baseline_understood: "transform_plan" },
      compare: { repair: "convert", accepted: "ready" },
    },
    acceptedPhases: ["compare"],
    acceptedEvidence: (state) =>
      /\.(step|stp)$/i.test(state.currentArtifactPath ?? "")
        ? ["visual", "geometry", "compare"]
        : ["convert"],
    finishEvidence: (state) =>
      /\.(step|stp)$/i.test(state.currentArtifactPath ?? "")
        ? ["visual", "geometry", "compare"]
        : ["convert"],
    requiresBaselineInput: true,
    baselineEvidenceRequired: true,
    updatesHeadOnAccept: true,
  };
}

// ---------------------------------------------------------------------------
// Design core fragments (lineage × structure)
// ---------------------------------------------------------------------------

/**
 * Legacy part: the exact 0.7 modify process. This fragment is the
 * equivalence anchor for the compiler against 0.7 behavior.
 */
function legacyPartFragment(): WorkflowSpec {
  return {
    nextAfterRequirements: "baseline",
    sourcePhases: ["modify"],
    candidateReviewPhase: "review",
    planNext: { plan: "modify" },
    planStayPhases: [],
    transitions: {
      baseline: { baseline_understood: "plan" },
      review: {
        revise: "modify",
        local_geometry_issue: "modify",
        intent_issue: "plan",
        architecture_issue: "plan",
        accepted: "ready",
      },
    },
    acceptedPhases: ["review"],
    acceptedEvidence: visualGeometryCompare,
    finishEvidence: visualGeometryCompare,
    requiresBaselineInput: true,
    baselineEvidenceRequired: true,
    updatesHeadOnAccept: true,
  };
}

/**
 * Greenfield / hybrid part. Hybrid keeps a concept phase (retained legacy
 * interfaces must be reconciled with free modules); greenfield compiles to
 * the fast path: requirements → part_design → build → review.
 */
function partFragment(lineage: "greenfield" | "hybrid"): WorkflowSpec {
  const transitions: Partial<Record<CadPhase, Record<string, CadPhase>>> = {
    part_design: { plan_committed: "build" },
    review: {
      revise: "build",
      local_geometry_issue: "build",
      interface_or_detail_issue: "part_design",
      architecture_issue: lineage === "hybrid" ? "concept" : "part_design",
      accepted: "ready",
    },
  };
  if (lineage === "hybrid") {
    transitions.baseline = { baseline_understood: "concept" };
    transitions.concept = {
      domain_work_needed: "domain_analysis",
      explore_more: "concept",
      direction_selected: "part_design",
    };
    transitions.domain_analysis = { domain_question_answered: "concept" };
  }
  return {
    nextAfterRequirements: lineage === "hybrid" ? "baseline" : "part_design",
    sourcePhases: ["build"],
    candidateReviewPhase: "review",
    planNext: { part_design: "build" },
    planStayPhases: [],
    transitions,
    acceptedPhases: ["review"],
    acceptedEvidence: visualGeometry,
    finishEvidence: visualGeometry,
    requiresBaselineInput: lineage === "hybrid",
    baselineEvidenceRequired: lineage === "hybrid",
    updatesHeadOnAccept: true,
  };
}

/**
 * Assembly structure fragment:
 *   [baseline] → system_concept → assembly_design → interface_design →
 *   part_design → build/modify → integration_review
 * Legacy assemblies skip system_concept (the architecture already exists)
 * but still owe the assembly_design and interface_contracts records.
 */
function assemblyFragment(lineage: "greenfield" | "legacy" | "hybrid"): WorkflowSpec {
  const sourcePhase = lineage === "legacy" ? "modify" : "build";
  const accepted = lineage === "legacy" ? ["visual", "geometry", "compare"] : ["visual", "geometry"];
  const transitions: Partial<Record<CadPhase, Record<string, CadPhase>>> = {
    // Record commits are the only exits from the design phases; they are
    // performed by cad_commit_assembly_design / cad_commit_interface_contracts.
    assembly_design: { assembly_design_committed: "interface_design" },
    interface_design: { interface_contracts_committed: "part_design" },
    part_design: { plan_committed: sourcePhase },
    integration_review: {
      revise: sourcePhase,
      local_geometry_issue: sourcePhase,
      interface_or_detail_issue: "interface_design",
      architecture_issue: "assembly_design",
      accepted: "ready",
    },
  };
  if (lineage === "legacy") {
    transitions.baseline = { baseline_understood: "assembly_design" };
  } else {
    transitions.system_concept = {
      domain_work_needed: "domain_analysis",
      explore_more: "system_concept",
      direction_selected: "assembly_design",
    };
    transitions.domain_analysis = { domain_question_answered: "system_concept" };
    if (lineage === "hybrid") {
      transitions.baseline = { baseline_understood: "system_concept" };
    }
  }
  return {
    nextAfterRequirements:
      lineage === "greenfield" ? "system_concept" : "baseline",
    sourcePhases: [sourcePhase],
    candidateReviewPhase: "integration_review",
    planNext: { part_design: sourcePhase },
    planStayPhases: [],
    transitions,
    acceptedPhases: ["integration_review"],
    acceptedEvidence: () => [...accepted],
    finishEvidence: () => [...accepted],
    requiresBaselineInput: lineage !== "greenfield",
    baselineEvidenceRequired: lineage !== "greenfield",
    updatesHeadOnAccept: true,
    // Review regressions stale the downstream record trail: re-entering
    // assembly_design invalidates both records, re-entering
    // interface_design invalidates the contracts — the review loop must
    // re-commit, never reuse the stale trail.
    recordStaleOnEnter: {
      assembly_design: ["assembly_design", "interface_contracts"],
      interface_design: ["interface_contracts"],
    },
  };
}

/** The design core of a route: lineage × structure, ending in its review. */
function designCoreFragment(route: DesignRoute): WorkflowSpec {
  if (route.structure === "part") {
    return route.lineage === "legacy" ? legacyPartFragment() : partFragment(route.lineage);
  }
  return assemblyFragment(route.lineage);
}

// ---------------------------------------------------------------------------
// Maturity suffix (release)
// ---------------------------------------------------------------------------

/**
 * Release SUFFIX (whitepaper 6.1): release never replaces the design
 * process — it appends the workstream process AFTER the design core's
 * review. The design review's "accepted" event enters the audit instead of
 * closing the run; final_review's "accepted" closes it.
 *
 *   design core ... → review/integration_review --accepted--> audit →
 *   gap_closure → package → final_review --accepted--> ready
 */
const RELEASE_SUFFIX_TRANSITIONS: Partial<Record<CadPhase, Record<string, CadPhase>>> = {
  audit: {
    audit_complete: "gap_closure",
    workstreams_structurally_closed: "package",
  },
  gap_closure: { workstreams_structurally_closed: "package" },
  package: { package_prepared: "final_review" },
  final_review: {
    artifact_issue: "package",
    engineering_issue: "gap_closure",
    accepted: "ready",
  },
};

function appendReleaseSuffix(spec: WorkflowSpec, route: DesignRoute): WorkflowSpec {
  const designReview = spec.candidateReviewPhase;
  const transitions: Partial<Record<CadPhase, Record<string, CadPhase>>> = {
    ...spec.transitions,
    ...RELEASE_SUFFIX_TRANSITIONS,
  };
  // The design review hands INTO the release suffix instead of closing.
  const designRow = { ...(transitions[designReview] ?? {}) };
  designRow.accepted = "audit";
  transitions[designReview] = designRow;

  return {
    ...spec,
    transitions,
    // gap_closure is the productive engineering phase of the release
    // suffix: edit CAD source, commit a candidate, and the harness
    // rebuilds — those candidates land in audit, not the design review.
    sourcePhases: [...spec.sourcePhases, "gap_closure"],
    sourcePhaseReviews: { gap_closure: "audit" },
    planStayPhases: [...spec.planStayPhases, "audit", "gap_closure", "package"],
    acceptedPhases: [...spec.acceptedPhases, "final_review"],
    mutationPolicies: {
      ...(spec.mutationPolicies ?? {}),
      gap_closure: "allowed",
      package: "allowed",
    },
  };
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Map a record obligation to the phase that owes it. frame_context is owed
 * by whichever baseline phase the route's objective uses.
 */
function recordPhaseFor(recordType: string, route: Route): CadPhase {
  switch (recordType) {
    case "frame_context":
      return route.objective === "convert" ? "source_baseline" : "baseline";
    case "assembly_design":
      return "assembly_design";
    case "interface_contracts":
      return "interface_design";
    default:
      // Unknown record types have no phase to bind to; the consistency
      // test catches these before they can ship.
      return "audit";
  }
}

function phaseRecordsFor(route: Route): Partial<Record<CadPhase, string[]>> {
  const byPhase: Partial<Record<CadPhase, string[]>> = {};
  for (const key of recordObligations(route)) {
    const recordType = key.slice("record:".length);
    const phase = recordPhaseFor(recordType, route);
    byPhase[phase] = [...(byPhase[phase] ?? []), recordType];
  }
  return byPhase;
}

export function compileWorkflow(route: Route): CompiledProcess {
  const obligations = [...obligationsOf(route)].sort();
  const base: CompiledProcess = {
    route,
    obligations,
    phaseRecords: {},
  };

  if (route.objective === "analyze") {
    return { ...base, ...analyzeFragment(), phaseRecords: phaseRecordsFor(route) };
  }
  if (route.objective === "convert") {
    return { ...base, ...convertFragment(), phaseRecords: phaseRecordsFor(route) };
  }

  let spec = designCoreFragment(route);
  if (route.maturity === "release") {
    spec = appendReleaseSuffix(spec, route);
  }
  return { ...base, ...applyOverlays(spec, route), phaseRecords: phaseRecordsFor(route) };
}

/**
 * Maturity and structure overlays (whitepaper 3.1/6.1): overlays add
 * obligations, never rewrite the process. Evidence obligations turn into
 * extra evidence kinds — for release routes only at the FINAL review and
 * at finish, because the design review's accepted merely hands into the
 * release suffix and must not demand release deliverables prematurely.
 */
function applyOverlays(spec: WorkflowSpec, route: DesignRoute): WorkflowSpec {
  const extra: EvidenceRef["kind"][] = [];
  const rank = MATURITY_RANK[route.maturity];
  if (rank >= MATURITY_RANK.manufacturing) {
    // A design you intend to manufacture must have been drawn.
    extra.push("drawing");
  }
  if (route.structure === "assembly") {
    // Assemblies owe their structural observations at every maturity —
    // including release, where the audit workstreams do not replace them.
    extra.push("assembly", "interference");
  }
  if (route.maturity === "release") {
    // Release closure owes rendered presentation evidence for the current
    // design version (the manifest's deliverables are verified separately).
    extra.push("presentation");
  }
  if (extra.length === 0) return spec;

  const withExtra = (kinds: EvidenceRef["kind"][]): EvidenceRef["kind"][] => [
    ...kinds,
    ...extra.filter((kind) => !kinds.includes(kind)),
  ];
  const isClosureReview = (state: CadRunState): boolean =>
    route.maturity !== "release" || state.phase === "final_review";

  const acceptedEvidence: EvidenceKindsResolver = (state) => {
    const kinds = spec.acceptedEvidence(state);
    return isClosureReview(state) ? withExtra(kinds) : kinds;
  };
  return {
    ...spec,
    acceptedEvidence,
    finishEvidence: (state) => withExtra(spec.finishEvidence(state)),
    // Release workstreams gate the closure only, never the design review.
    completionGuard:
      route.maturity === "release"
        ? (state) => (state.phase === "final_review" ? releaseCompletionGuard(state) : null)
        : spec.completionGuard,
  };
}
