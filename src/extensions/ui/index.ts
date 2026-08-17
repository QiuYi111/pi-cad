import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CadProjectState } from "../../shared/protocol.ts";
import { ProjectStateStore } from "../../shared/store.ts";

export default function cadUiExtension(pi: ExtensionAPI) {
  pi.events.on("pi-cad:state-changed", (state: CadProjectState) => {
    const text = [
      `Pi-CAD · ${state.workflow ?? "intake"}`,
      `phase=${state.phase}`,
      `status=${state.status}`,
      state.candidateLabel ? `candidate=${state.candidateLabel}` : "",
      state.currentArtifactHash ? `artifact=${state.currentArtifactHash.slice(0, 12)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // Read-only status projection. This extension owns no workflow state.
    pi.setSessionName(text.slice(0, 80));
  });

  pi.registerCommand("cad-status", {
    description: "Show the canonical Pi-CAD workflow state",
    handler: async (_args, ctx) => {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await store.load();
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("No Pi-CAD workflow is active", "info");
        return;
      }
      const lines = [
        `Pi-CAD · ${state.workflow ?? "intake"}`,
        `phase=${state.phase} status=${state.status} policy=${state.mutationPolicy}`,
        `maturity=${state.maturity}`,
        state.baselineArtifactHash ? `baseline=${state.baselineArtifactHash.slice(0, 12)}` : "",
        state.currentArtifactHash ? `artifact=${state.currentArtifactHash.slice(0, 12)}` : "",
        `evidence=${state.evidence.map((e) => e.kind).join(",") || "none"}`,
      ].filter(Boolean);
      if (ctx.mode === "tui") {
        ctx.ui.setWidget("pi-cad-status", lines);
      } else {
        ctx.ui.notify(lines.join(" "), "info");
      }
    },
  });
}
