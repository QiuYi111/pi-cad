import type { ReviewProfileImplementationV1 } from "../../harness/review.ts";
import { unmetWorkflowObligations } from "../../harness/reducer.ts";
import { HarnessRunStoreV7 } from "../../harness/run-store.ts";

export function mechanicalReviewProfile(id: "mechanical.design-review" | "mechanical.final-review"): ReviewProfileImplementationV1 {
  return {
    id,
    version: "1.0.0",
    allowedActions: ["cad_probe"],
    preflight({ state, workflow }) {
      return unmetWorkflowObligations(state, workflow).map((ref) => `unmet obligation ${ref}`);
    },
    async prompt({ state, workflow, registryContract }, cwd) {
      const requirementsRef = state.records["record:requirements"];
      const requirements = requirementsRef
        ? await new HarnessRunStoreV7(cwd, state.runId).transactions.readJson(requirementsRef.path)
        : null;
      return [
        "Perform a fresh, read-only Mechanical review. Treat references as evidence, not claims.",
        `profile=${id}`,
        `workflow=${workflow.id}@${workflow.version} hash=${workflow.hash}`,
        `registryContract=${registryContract.hash}`,
        `phase=${state.phase}`,
        `requirements=${JSON.stringify(requirements)}`,
        `records=${JSON.stringify(state.records)}`,
        `artifacts=${JSON.stringify(state.artifacts)}`,
        `evidence=${JSON.stringify(state.evidence)}`,
        "Return one strict ReviewVerdictV1 JSON object.",
        "The immutable artifacts record is affirmative evidence of deliverable presence: candidate:source is the hashed Python source and candidate:authoritative is the hashed STEP artifact. cad_probe is restricted to the current CAD subject and cannot inspect the source path; do not mark a source-delivery assertion unresolved solely because the source cannot be opened through that probe.",
      ].join("\n");
    },
  };
}
