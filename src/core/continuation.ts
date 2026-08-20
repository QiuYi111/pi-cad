import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CadRunState } from "../shared/protocol.ts";
import type { CadProjectStore } from "../shared/store.ts";
import { stateSummary } from "./context.ts";

const nudgedVersions = new Set<string>();
const SOURCE_OR_REVIEW_PHASES = ["build", "modify", "convert", "review", "compare"];

export interface AutoContinueOptions {
  /**
   * Bypass the nudgedVersions dedup. Phase and status checks still apply.
   * Required after a context rebuild: the rebuild typically happens on the
   * second (or later) autonomous continuation of the SAME phase+artifact
   * version, whose nudge key was already consumed — without force, the
   * post-compaction continuation would be silently swallowed and the run
   * would stall waiting for a user who was never asked anything.
   */
  force?: boolean;
}

export async function maybeAutoContinue(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  _ctx: ExtensionContext,
  options: AutoContinueOptions = {},
): Promise<void> {
  if (!SOURCE_OR_REVIEW_PHASES.includes(state.phase)) return;
  if (state.status !== "active") return;
  const key = `${state.runId}:${state.phase}:${state.currentSourceHash ?? "none"}:${state.currentArtifactHash ?? "none"}`;
  if (!options.force && nudgedVersions.has(key)) return;
  nudgedVersions.add(key);
  pi.sendUserMessage(
    `Pi-CAD workflow is still in ${state.phase.toUpperCase()} (${stateSummary(state)}). Continue with the next explicit cad_* action.`,
    { deliverAs: "followUp" },
  );
}
