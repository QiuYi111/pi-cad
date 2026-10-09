/**
 * Evidence vocabulary: the kinds the workflow compiler requires, and the
 * evidence obligations a requirements record declares. Opaque to the harness.
 */

import type { ACTIVE_SIMULATION_TOOLS } from "../public-tools.ts";

/** What a piece of evidence is about. Workflow evidence rules are written in these kinds. */
export type EvidenceKind =
  | "visual"
  | "geometry"
  | "surfaces"
  | "build"
  | "compare"
  | "section"
  | "drawing"
  | "simulation"
  | "presentation"
  | "convert"
  | "assembly"
  | "interference"
  | "sections"
  | "optimization";

export interface EvidenceInputArtifact {
  path: string;
  sha256: string;
  /** Provenance role, e.g. spec | artifact | fluidDomain. Opaque to the harness. */
  role: string;
  /** File hash by default; Simulation V2 declared paths use its tree identity. */
  hashKind?: "sha256-file" | "simulation-tree-v1";
}

type EvidenceDisposition =
  | "required"
  | "optional"
  | "not_applicable"
  | "blocked_external";

/**
 * Opaque simulation case: the harness only knows that this interpreter
 * invocation must exist for the current artifact version. Domain semantics
 * remain opaque to the workflow core.
 */
interface SimulationCaseObligation {
  id: string;
  tool: (typeof ACTIVE_SIMULATION_TOOLS)[number];
}

export interface EvidenceObligations {
  simulation?: {
    disposition: EvidenceDisposition;
    rationale?: string;
    /**
     * Case-scoped obligations. When present, "required" means every listed
     * case must have current simulation evidence from the declared tool;
     * when absent, any current simulation evidence satisfies the obligation.
     */
    cases?: SimulationCaseObligation[];
  };
}
