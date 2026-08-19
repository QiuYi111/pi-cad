/**
 * Opaque simulation-case matching.
 *
 * The harness never understands what a case physically is; it only checks
 * that the interpreter invocations the Agent itself declared as obligations
 * produced current-version simulation observations with the declared tool
 * and case id. Kept dependency-free so state-machine.ts can import it
 * without cycles.
 */
import type { CadRunState, SimulationCaseObligation } from "../shared/protocol.ts";

export function unmetSimulationCases(
  state: CadRunState,
  artifactHash: string | undefined,
): SimulationCaseObligation[] {
  const simulation = state.evidenceObligations?.simulation;
  const cases = simulation?.cases;
  // Cases only carry obligations under disposition "required"; an optional
  // or not-applicable simulation with case annotations must never block.
  if (simulation?.disposition !== "required" || !cases?.length || !artifactHash) {
    return [];
  }
  return cases.filter((obligation) => {
    return !state.evidence.some(
      (ref) =>
        ref.kind === "simulation" &&
        ref.artifactHash === artifactHash &&
        ref.tool === obligation.tool &&
        ref.caseId === obligation.id &&
        !state.staleEvidence.includes(ref),
    );
  });
}

export function caseObligationFailure(
  state: CadRunState,
  artifactHash: string | undefined,
  label: string,
): string | null {
  const unmet = unmetSimulationCases(state, artifactHash);
  if (!unmet.length) return null;
  return `${label}: required simulation case not satisfied for the current artifact version: ${unmet
    .map((c) => `${c.id} (${c.tool})`)
    .join(", ")}`;
}
