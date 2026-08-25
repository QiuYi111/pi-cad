interface PhaseCardMessageInput {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  digest: string;
  workflowHash: string;
  phase: string;
}

export const PHASE_CARD_CUSTOM_TYPE = "pi-cad.phase-card";

export function makeEphemeralPhaseCardMessage(card: PhaseCardMessageInput) {
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
