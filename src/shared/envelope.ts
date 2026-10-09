import type { BuildPayload, CadEventEnvelope, GeometryPayload, VisualPayload } from "./protocol.ts";

export function envelopeArtifactHash(
  envelope: CadEventEnvelope,
  kind = "step",
): string | undefined {
  const artifact = envelope.artifacts?.find((entry) => entry.kind === kind);
  return artifact?.sha256 ?? envelope.outputHashes?.[artifact?.path ?? ""];
}

export function artifactPathForKind(envelope: CadEventEnvelope, kind: string): string | undefined {
  return envelope.artifacts?.find((entry) => entry.kind === kind)?.path;
}

export function payloadOf<T>(envelope: CadEventEnvelope): T {
  return envelope.payload as T;
}

export function buildPayload(envelope: CadEventEnvelope): BuildPayload {
  return payloadOf<BuildPayload>(envelope);
}

export function visualPayload(envelope: CadEventEnvelope): VisualPayload {
  return payloadOf<VisualPayload>(envelope);
}

export function geometryPayload(envelope: CadEventEnvelope): GeometryPayload {
  return payloadOf<GeometryPayload>(envelope);
}
