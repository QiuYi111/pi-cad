/**
 * Phase vocabulary and execution modes. Shared by the workflow compiler,
 * the mechanical domain and the agent contract.
 */

export type CadPhase =
  | "intake"
  | "requirements"
  | "build"
  | "review"
  | "ready"
  | "done"
  | "baseline"
  | "investigate"
  | "explain"
  | "plan"
  | "modify"
  | "concept"
  | "domain_analysis"
  | "source_baseline"
  | "transform_plan"
  | "convert"
  | "compare"
  | "audit"
  | "gap_closure"
  | "package"
  | "final_review"
  // 0.8 structure fragment phases
  | "system_concept"
  | "assembly_design"
  | "interface_design"
  | "part_design"
  | "integration_review";

/** Every phase, in a stable order (phase matrices and contracts iterate this). */
export const CAD_PHASES: readonly CadPhase[] = [
  "intake",
  "requirements",
  "build",
  "review",
  "ready",
  "done",
  "baseline",
  "investigate",
  "explain",
  "plan",
  "modify",
  "concept",
  "domain_analysis",
  "source_baseline",
  "transform_plan",
  "convert",
  "compare",
  "audit",
  "gap_closure",
  "package",
  "final_review",
  "system_concept",
  "assembly_design",
  "interface_design",
  "part_design",
  "integration_review",
] as const;

export type InteractionMode = "interactive" | "headless";

export type MutationPolicy = "read_only" | "source_only" | "allowed";
