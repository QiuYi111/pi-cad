import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CadRunState } from "../shared/protocol.ts";
import type { CadProjectStore } from "../shared/store.ts";
import { stateSummary } from "./context.ts";
import { isHeadless } from "./interaction-mode.ts";

const nudgedVersions = new Set<string>();
const headlessContinuationCounts = new Map<string, number>();
const INTERACTIVE_AUTO_PHASES = ["build", "modify", "convert", "review", "compare"];
const DEFAULT_HEADLESS_MAX_CONTINUATIONS = 24;

function headlessMaxContinuations(): number {
  const value = Number(process.env.PI_CAD_HEADLESS_MAX_CONTINUATIONS);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_HEADLESS_MAX_CONTINUATIONS;
}

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
  if (state.status !== "active") return;
  if (isHeadless(state)) {
    const used = headlessContinuationCounts.get(state.runId) ?? 0;
    const limit = headlessMaxContinuations();
    if (used >= limit) {
      const exhausted: CadRunState = {
        ...state,
        status: "budget_exhausted",
        updatedAt: new Date().toISOString(),
      };
      await store.save(exhausted);
      await store.appendEvent("HeadlessContinuationBudgetExhausted", {
        phase: state.phase,
        continuations: used,
        limit,
      });
      return;
    }
    headlessContinuationCounts.set(state.runId, used + 1);
    pi.sendUserMessage(
      `Pi-CAD HEADLESS continuation ${used + 1}/${limit}: workflow is still in ${state.phase.toUpperCase()} (${stateSummary(state)}). Continue with the next explicit cad_* action; do not wait for a user.`,
      { deliverAs: "followUp" },
    );
    return;
  }
  if (!INTERACTIVE_AUTO_PHASES.includes(state.phase)) return;
  const key = `${state.runId}:${state.phase}:${state.currentSourceHash ?? "none"}:${state.currentArtifactHash ?? "none"}`;
  if (!options.force && nudgedVersions.has(key)) return;
  nudgedVersions.add(key);
  pi.sendUserMessage(
    `Pi-CAD workflow is still in ${state.phase.toUpperCase()} (${stateSummary(state)}). Continue with the next explicit cad_* action.`,
    { deliverAs: "followUp" },
  );
}
