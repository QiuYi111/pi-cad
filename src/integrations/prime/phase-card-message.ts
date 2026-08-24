import type { PhaseCard } from "../../harness/card.ts";

export const PHASE_CARD_CUSTOM_TYPE = "pi-cad.phase-card";

export function makeEphemeralPhaseCardMessage(card: PhaseCard) {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: card.text },
    ...card.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
  ];
  return {
    role: "custom" as const,
    customType: PHASE_CARD_CUSTOM_TYPE,
    display: false,
    content,
    details: { digest: card.digest, workflowHash: card.workflowHash, phase: card.phase },
    timestamp: Date.now(),
  };
}
