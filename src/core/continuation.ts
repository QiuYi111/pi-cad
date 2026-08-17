import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CadProjectState } from "../shared/protocol.ts";
import type { CadProjectStore } from "../shared/store.ts";
import { stateSummary } from "./context.ts";

const nudgedVersions = new Set<string>();
const SOURCE_OR_REVIEW_PHASES = ["build", "modify", "convert", "review", "compare"];

export async function maybeAutoContinue(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadProjectState,
  _ctx: ExtensionContext,
): Promise<void> {
  if (!SOURCE_OR_REVIEW_PHASES.includes(state.phase)) return;
  if (state.status !== "active") return;
  const key = `${state.taskId}:${state.phase}:${state.currentSourceHash ?? "none"}:${state.currentArtifactHash ?? "none"}`;
  if (nudgedVersions.has(key)) return;
  nudgedVersions.add(key);
  pi.sendUserMessage(
    `Pi-CAD workflow is still in ${state.phase.toUpperCase()} (${stateSummary(state)}). Continue with the next explicit cad_* action.`,
    { deliverAs: "followUp" },
  );
}
