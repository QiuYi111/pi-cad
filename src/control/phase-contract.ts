/**
 * PhaseContract (refactor Phase 7).
 *
 * Replaces the hardcoded phase → tool-name lists in policies.ts with
 * phase → CAPABILITY grants. Tools are derived from capabilities via
 * CAPABILITY_GRANTS; the phase matrix itself stays frozen by the
 * phase-0 golden tests (any diff there is a behavior change).
 *
 * A contract also carries the route-independent control metadata the
 * control plane reasons about:
 *   - validDecisions: transition events the phase accepts (route-scoped);
 *   - requiredRecords: record obligations the phase owes (route-scoped);
 *   - contextProfile: how the context runtime treats this phase.
 */
import type { CadPhase } from "../shared/protocol.ts";
import { CAD_PHASES } from "../shared/protocol.ts";

export type Capability =
  // observation family
  | "observe" // unified cad_probe + historical observation recall
  | "observe_interference" // pairwise solid interference facts
  | "observe_programmable" // read-only programmable B-Rep computation
  // model family
  | "model_build" // execute geometry source
  | "deliverable" // export / drawing / render artifacts
  // simulation family
  | "simulate" // spec-driven solver cases
  | "optimize"; // differentiable optimization

export type ControlGrant =
  | "route"
  | "reroute"
  | "commit_requirements"
  | "commit_frame_context"
  | "commit_plan"
  | "commit_assembly_design"
  | "commit_interface_contracts"
  | "commit_candidate"
  | "transition"
  | "wait_for_user"
  | "finish";

/** File/shell access levels for builtin (non-cad) tools. */
export type AccessGrant = "file_read" | "shell" | "file_edit_source" | "file_edit_recipe";

export type PhaseGrant = AccessGrant | Capability | ControlGrant;

const GRANTS: Record<PhaseGrant, readonly string[]> = {
  // builtin access
  file_read: ["read", "grep", "find", "ls"],
  shell: ["bash"],
  file_edit_source: ["edit", "write"],
  file_edit_recipe: ["edit", "write"],

  // observation
  observe: [
    "cad_probe",
    "cad_recall_observation",
  ],
  observe_interference: ["cad_probe"],
  observe_programmable: ["cad_probe"],

  // model
  model_build: ["cad_build_step"],
  deliverable: ["cad_export", "cad_generate_drawing", "cad_render_scene"],

  // simulation
  simulate: ["cad_simulate", "cad_sim_observe", "cad_commit_simulation", "cad_derive_analysis_model"],
  optimize: ["cad_optimize"],

  // control
  route: ["cad_route"],
  reroute: ["cad_reroute"],
  commit_requirements: ["cad_commit_requirements"],
  commit_frame_context: ["cad_commit_frame_context"],
  commit_plan: ["cad_commit_plan"],
  commit_assembly_design: ["cad_commit_assembly_design"],
  commit_interface_contracts: ["cad_commit_interface_contracts"],
  commit_candidate: ["cad_commit_candidate"],
  transition: ["cad_transition"],
  wait_for_user: ["cad_wait_for_user"],
  finish: ["cad_finish"],
};

export function capabilityTools(grant: PhaseGrant): readonly string[] {
  return GRANTS[grant];
}

export interface PhaseContract {
  phase: CadPhase;
  grants: PhaseGrant[];
}

const SOURCE_GRANTS: PhaseGrant[] = [
  "file_read",
  "shell",
  "file_edit_source",
  "observe",
  "observe_interference",
  "model_build",
  "deliverable",
  "commit_candidate",
  "transition",
  "wait_for_user",
];

const REVIEW_GRANTS: PhaseGrant[] = [
  "file_read",
  "shell",
  "file_edit_recipe",
  "observe",
  "observe_interference",
  "observe_programmable",
  "simulate",
  "optimize",
  "transition",
  "wait_for_user",
  "commit_plan",
];

const COGNITIVE_CORE: PhaseGrant[] = [
  "file_read",
  "shell",
  "observe",
  "transition",
];

const COGNITIVE_GRANTS: PhaseGrant[] = [
  ...COGNITIVE_CORE,
  "commit_plan",
  "wait_for_user",
];

/** Phase → capability grants. The single source toolsForPhase compiles from. */
const PHASE_GRANTS: Record<CadPhase, PhaseGrant[]> = {
  intake: ["file_read", "route"],
  requirements: ["file_read", "shell", "commit_requirements", "wait_for_user"],

  // source phases: author geometry, probe it, propose candidates
  build: SOURCE_GRANTS,
  modify: SOURCE_GRANTS,
  convert: SOURCE_GRANTS,

  // candidate review: full observation + solver evidence + plan revision
  review: REVIEW_GRANTS,
  compare: REVIEW_GRANTS,
  integration_review: REVIEW_GRANTS,

  // cognitive phases: read-only reasoning over observed facts
  plan: COGNITIVE_GRANTS,
  part_design: COGNITIVE_GRANTS,
  transform_plan: COGNITIVE_GRANTS,
  assembly_design: [...COGNITIVE_CORE, "commit_assembly_design", "wait_for_user"],
  interface_design: [...COGNITIVE_CORE, "commit_interface_contracts", "wait_for_user"],

  baseline: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "commit_frame_context", "wait_for_user"],
  source_baseline: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "commit_frame_context", "wait_for_user"],
  investigate: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "wait_for_user"],
  explain: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "wait_for_user"],
  concept: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "wait_for_user"],
  system_concept: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "wait_for_user"],
  domain_analysis: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "wait_for_user"],
  final_review: [...COGNITIVE_CORE, "file_edit_recipe", "simulate", "wait_for_user"],

  // release suffix
  audit: [
    ...COGNITIVE_CORE,
    "observe_interference",
    "model_build",
    "deliverable",
    "file_edit_recipe",
    "simulate",
    "commit_assembly_design",
    "commit_interface_contracts",
    "commit_plan",
    "wait_for_user",
  ],
  gap_closure: [
    "file_read",
    "shell",
    "file_edit_source",
    "observe",
    "observe_interference",
    "model_build",
    "deliverable",
    "file_edit_recipe",
    "simulate",
    "optimize",
    "commit_candidate",
    "commit_plan",
    "transition",
    "wait_for_user",
  ],
  package: [
    "file_read",
    "shell",
    "file_edit_source",
    "observe",
    "observe_interference",
    "model_build",
    "deliverable",
    "file_edit_recipe",
    "simulate",
    "optimize",
    "commit_plan",
    "transition",
    "wait_for_user",
  ],

  ready: [
    "file_read",
    "shell",
    "observe",
    "observe_interference",
    "model_build",
    "deliverable",
    "file_edit_recipe",
    "simulate",
    "finish",
  ],
  done: ["file_read"],
};

/** Compile the contract for a phase. */
export function phaseContract(phase: CadPhase): PhaseContract {
  const grants = PHASE_GRANTS[phase];
  if (!grants) throw new Error(`no phase contract for ${phase}`);
  return { phase, grants };
}

/** Derive the concrete tool list from a contract (order-insensitive). */
export function contractTools(contract: PhaseContract): string[] {
  return [...new Set(contract.grants.flatMap((grant) => [...capabilityTools(grant)]))];
}

export function allPhaseContracts(): PhaseContract[] {
  return CAD_PHASES.map((phase) => phaseContract(phase));
}
