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
 *   - maturity overlay    (obligations only; never rewrites the process)
 *
 * The execution engine (WorkflowSpec / state machine) is unchanged: the
 * compiler is a definition mechanism, not a second engine.
 */

import type { CadPhase, CadRunState, EvidenceRef } from "../shared/protocol.ts";
import type { ObligationKey, Route } from "../shared/route.ts";
import { obligationsOf, RELEASE_WORKSTREAMS } from "../shared/route.ts";
import type { WorkflowSpec } from "./types.ts";

export interface CompiledProcess extends WorkflowSpec {
  route: Route;
  /** Opaque obligation keys (reroute monotonicity is subset comparison). */
  obligations: ObligationKey[];
  /**
   * Phase → record types owed BY that phase before progress can continue.
   * In the assembly chain the record commit is also the phase transition;
   * in release audit the records are committed without moving.
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

const releaseEvidence = (state: CadRunState): EvidenceRef["kind"][] =>
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
// Design fragments
// ---------------------------------------------------------------------------

interface DesignOptions {
  /** Source phase: legacy edits existing sources; others author new ones. */
  sourcePhase: "build" | "modify";
  /** Review phase: assemblies integrate, parts review. */
  reviewPhase: "review" | "integration_review";
  /** Accepted evidence follows lineage, not structure. */
  accepted: EvidenceRef["kind"][];
}

function designReviewTransitions(
  opts: DesignOptions,
  backToPlan: CadPhase,
  backToArchitecture: CadPhase,
): Partial<Record<CadPhase, Record<string, CadPhase>>> {
  const review: Record<string, CadPhase> = {
    revise: opts.sourcePhase,
    local_geometry_issue: opts.sourcePhase,
    interface_or_detail_issue: backToPlan,
    architecture_issue: backToArchitecture,
    accepted: "ready",
  };
  return { [opts.reviewPhase]: review };
}

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
 *   system_concept → assembly_design → interface_design → part_design →
 *   build → integration_review
 * Legacy assemblies skip system_concept (the architecture already exists)
 * but still owe the assembly_design and interface_contracts records.
 */
function assemblyFragment(lineage: "greenfield" | "legacy" | "hybrid"): WorkflowSpec {
  const sourcePhase = lineage === "legacy" ? "modify" : "build";
  const opts: DesignOptions = {
    sourcePhase,
    reviewPhase: "integration_review",
    accepted: lineage === "legacy" ? ["visual", "geometry", "compare"] : ["visual", "geometry"],
  };
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
    acceptedEvidence: () => [...opts.accepted, "assembly"],
    finishEvidence: () => [...opts.accepted, "assembly"],
    requiresBaselineInput: lineage !== "greenfield",
    baselineEvidenceRequired: lineage !== "greenfield",
    updatesHeadOnAccept: true,
  };
}

/**
 * Maturity=release replaces the productive process with the release
 * workstream process (audit → gap_closure → package → final_review),
 * prefixed by the lineage baseline when one is required.
 */
function releaseFragment(lineage: "greenfield" | "legacy" | "hybrid"): WorkflowSpec {
  const withBaseline = lineage !== "greenfield";
  const transitions: Partial<Record<CadPhase, Record<string, CadPhase>>> = {
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
  if (withBaseline) {
    transitions.baseline = { baseline_understood: "audit" };
  }
  return {
    nextAfterRequirements: withBaseline ? "baseline" : "audit",
    // Gap closure is the productive engineering phase of release work:
    // edit CAD source, commit a candidate, and let the harness rebuild.
    sourcePhases: ["gap_closure"],
    candidateReviewPhase: "audit",
    planNext: {},
    planStayPhases: ["audit", "gap_closure", "package"],
    transitions,
    acceptedPhases: ["final_review"],
    acceptedEvidence: releaseEvidence,
    finishEvidence: releaseEvidence,
    requiresBaselineInput: withBaseline,
    baselineEvidenceRequired: withBaseline,
    mutationPolicies: { gap_closure: "allowed", package: "allowed" },
    updatesHeadOnAccept: true,
    completionGuard: releaseCompletionGuard,
  };
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export function compileWorkflow(route: Route): CompiledProcess {
  const obligations = [...obligationsOf(route)].sort();
  const base: CompiledProcess = {
    route,
    obligations,
    phaseRecords: {},
  };

  if (route.objective === "analyze") {
    return { ...base, ...analyzeFragment() };
  }
  if (route.objective === "convert") {
    return { ...base, ...convertFragment() };
  }

  const phaseRecords: Partial<Record<CadPhase, string[]>> = {};
  let spec: WorkflowSpec;
  if (route.maturity === "release") {
    spec = releaseFragment(route.lineage);
    if (route.structure === "assembly") {
      // Assembly records are audited in the release audit phase and must
      // exist before gap closure starts changing sources. The audit phase
      // exposes both record tools; committing them does not move the phase.
      phaseRecords.audit = ["assembly_design", "interface_contracts"];
    }
  } else if (route.structure === "part") {
    spec = route.lineage === "legacy" ? legacyPartFragment() : partFragment(route.lineage);
  } else {
    spec = assemblyFragment(route.lineage);
    phaseRecords.assembly_design = ["assembly_design"];
    phaseRecords.interface_design = ["interface_contracts"];
  }

  return { ...base, ...spec, phaseRecords };
}
