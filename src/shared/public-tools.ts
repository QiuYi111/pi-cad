/**
 * Canonical agent-facing Pi-CAD tool surface.
 *
 * New workflow policy, capability diagnostics, documentation coverage, and
 * extension registration tests must agree with this catalog. Historical tool
 * names are deliberately separate: they may be parsed from journals, but must
 * never be registered or granted to a new workflow.
 */
export const ACTIVE_PUBLIC_TOOLS = {
  control: [
    "cad_route",
    "cad_reroute",
    "cad_commit_requirements",
    "cad_revise_requirements",
    "cad_commit_frame_context",
    "cad_commit_plan",
    "cad_commit_assembly_design",
    "cad_commit_interface_contracts",
    "cad_commit_candidate",
    "cad_submit_for_review",
    "cad_transition",
    "cad_wait_for_user",
    "cad_defer_clarification",
    "cad_declare_blocker",
    "cad_finish",
    "cad_commit_simulation",
  ],
  probe: ["cad_probe", "cad_recall_observation"],
  model: ["cad_build_step", "cad_derive_analysis_model"],
  simulation: ["cad_simulate", "cad_sim_observe"],
  optimization: ["cad_optimize"],
  deliverable: ["cad_export", "cad_generate_drawing", "cad_render_scene"],
} as const;

export type PublicToolGroup = keyof typeof ACTIVE_PUBLIC_TOOLS;
export type ActivePublicTool = (typeof ACTIVE_PUBLIC_TOOLS)[PublicToolGroup][number];

export const ACTIVE_PUBLIC_TOOL_NAMES = Object.freeze(
  Object.values(ACTIVE_PUBLIC_TOOLS).flat(),
) as readonly ActivePublicTool[];

export const ACTIVE_CONTROL_TOOLS = ACTIVE_PUBLIC_TOOLS.control;
export const ACTIVE_CAPABILITY_TOOLS = Object.freeze([
  ...ACTIVE_PUBLIC_TOOLS.probe,
  ...ACTIVE_PUBLIC_TOOLS.model,
  ...ACTIVE_PUBLIC_TOOLS.simulation,
  ...ACTIVE_PUBLIC_TOOLS.optimization,
  ...ACTIVE_PUBLIC_TOOLS.deliverable,
]) as readonly ActivePublicTool[];

export const ACTIVE_SIMULATION_TOOLS = ["cad_simulate"] as const;
export const ACTIVE_PROBE_TOOLS = ["cad_probe"] as const;

export const HISTORICAL_TOOL_NAMES = [
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_surfaces",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_inspect_interference",
  "cad_scan_sections",
  "cad_probe_python",
  "cad_simulate_structural_legacy",
  "cad_simulate_flow",
  "cad_simulate_thermal",
] as const;
