import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeEphemeralPhaseCardMessage, PHASE_CARD_CUSTOM_TYPE } from "./phase-card-message.ts";
import { requestAuthority } from "./sidecar-client.ts";

interface SidecarPhaseCard {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  digest: string;
  workflowHash: string;
  phase: string;
}

/** The entire Prime integration: inject one current, non-persisted card per call. */
export default function piCadPhaseCard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "codex_generate_image") return undefined;
    try {
      const decision = await requestAuthority<null | { allowed: boolean; rendered?: string }>({ op: "authorize", operation: "image.generate" });
      // Imagegen remains a general Prime capability outside an active CAD run.
      if (!decision || decision.allowed) return undefined;
      return { block: true, reason: decision.rendered ?? "image.generate is not authorized by the current workflow" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `Pi-CAD authority sidecar unavailable: ${reason}` };
    }
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === PHASE_CARD_CUSTOM_TYPE));
    try {
      const card = await requestAuthority<SidecarPhaseCard | null>({ op: "phase-card" });
      if (!card) return messages.length === event.messages.length ? undefined : { messages };
      return { messages: [...messages, makeEphemeralPhaseCardMessage(card)] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const warning = reason.length > 240 ? `${reason.slice(0, 237)}...` : reason;
      return {
        messages: [...messages, {
          role: "custom", customType: PHASE_CARD_CUSTOM_TYPE, display: false,
          content: [
            "WHERE", "- authority sidecar unavailable", "",
            "GOAL", "- preserve fail-closed workflow behavior", "",
            "SOP", "- restore the Pi-CAD authority sidecar before engineering mutations", "",
            "MUST", "- reconnect canonical workflow authority", "",
            "CAN", "- none", "",
            "NEXT", "- none", "",
            "STATE", "- canonical state could not be read; workspace projections have no authority", "",
            "WARNINGS", `- Phase Card unavailable: ${warning}`,
          ].join("\n"),
          details: { warning: true }, timestamp: Date.now(),
        }],
      };
    }
  });
}
