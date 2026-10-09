import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { mechanicalRegistries } from "../../domains/mechanical/registries.ts";
import { resolveActiveRun } from "../../harness/run-scope.ts";

export default function cadUiExtension(pi: ExtensionAPI) {
  pi.registerCommand("cad-status", {
    description: "Show the active Pi-CAD workflow run (phase and run id)",
    handler: async (_args, ctx) => {
      const loaded = await resolveActiveRun(ctx.cwd, mechanicalRegistries);
      if (!loaded) {
        if (ctx.hasUI) ctx.ui.notify("No Pi-CAD workflow is active", "info");
        return;
      }
      const { state, workflow } = loaded;
      const lines = [
        `Pi-CAD · workflow=${workflow.id}@${workflow.version}`,
        `run=${state.runId}`,
        `phase=${state.phase} status=${state.status}`,
      ];
      if (ctx.mode === "tui") {
        ctx.ui.setWidget("pi-cad-status", lines);
      } else {
        ctx.ui.notify(lines.join(" "), "info");
      }
    },
  });
}
