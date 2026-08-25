import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { compilePhaseCard } from "../../harness/card.ts";
import { makeEphemeralPhaseCardMessage, PHASE_CARD_CUSTOM_TYPE } from "./phase-card-message.ts";
import { currentAuthorization } from "../../agent-api/authorization.ts";
import { renderAuthorizationDenied } from "../../harness/permissions.ts";

/** The entire Prime integration: inject one current, non-persisted card per call. */
export default function piCadPhaseCard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "codex_generate_image") return undefined;
    const decision = await currentAuthorization(ctx.cwd, "image.generate");
    // Imagegen remains a general Prime capability outside an active CAD run.
    if (!decision || decision.allowed) return undefined;
    return { block: true, reason: renderAuthorizationDenied(decision) };
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === PHASE_CARD_CUSTOM_TYPE));
    try {
      const card = await compilePhaseCard(ctx.cwd);
      if (!card) return messages.length === event.messages.length ? undefined : { messages };
      return { messages: [...messages, makeEphemeralPhaseCardMessage(card)] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const warning = reason.length > 240 ? `${reason.slice(0, 237)}...` : reason;
      return {
        messages: [...messages, {
          role: "custom", customType: PHASE_CARD_CUSTOM_TYPE, display: false,
          content: `[Pi-CAD]\n\nWarnings\n- Phase Card unavailable: ${warning}`,
          details: { warning: true }, timestamp: Date.now(),
        }],
      };
    }
  });
}
