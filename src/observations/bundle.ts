/**
 * Observation Layer (refactor Phase 1): ObservationBundle.
 *
 * A bundle is the normalized, agent-facing projection of a backend
 * envelope. The envelope (`CadEventEnvelope`) stays the wire contract
 * with `python -m cadctl` — it is NEVER shown to the agent directly
 * after Phase 1. The bundle is what the agent sees, what prompts reason
 * about, and (Phase 8) what the context runtime indexes.
 *
 * Visual-first: visuals are the primary engineering signal; facts come
 * second; diagnostics third; provenance and artifacts close the record.
 */
import type { CadEventEnvelope } from "../shared/protocol.ts";

export interface ObservationVisual {
  name: string;
  path: string;
}

export interface ObservationFact {
  key: string;
  value: string;
}

export interface ObservationDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
}

export interface ObservationProvenance {
  tool: string;
  toolVersion?: string;
  backendVersion?: string;
  durationMs: number;
  inputHashes: Record<string, string>;
  outputHashes: Record<string, string>;
}

/** ArtifactRef: the only cross-module artifact currency (design doc §5.1). */
export interface ObservationArtifactRef {
  path: string;
  kind: string;
  sha256: string;
  role?: string;
}

export interface ObservationBundle {
  ok: boolean;
  /** cadctl tool that produced the backing envelope (e.g. "render"). */
  tool: string;
  headline: string;
  visuals: ObservationVisual[];
  facts: ObservationFact[];
  diagnostics: ObservationDiagnostic[];
  provenance: ObservationProvenance;
  artifacts: ObservationArtifactRef[];
}

export interface BundleInputs {
  headline: string;
  visuals?: ObservationVisual[];
  facts?: ObservationFact[];
  diagnostics?: ObservationDiagnostic[];
  /** Provenance-role annotations for envelope artifacts (kind → role). */
  artifactRoles?: Record<string, string>;
}

export function bundleFromEnvelope(
  envelope: CadEventEnvelope,
  inputs: BundleInputs,
): ObservationBundle {
  const diagnostics: ObservationDiagnostic[] = [...(inputs.diagnostics ?? [])];
  for (const warning of envelope.warnings ?? []) {
    diagnostics.push({ level: "warning", message: warning });
  }
  if (!envelope.ok) {
    const error = typeof envelope.payload?.error === "string"
      ? envelope.payload.error
      : "unknown error";
    diagnostics.push({ level: "error", message: error });
  }

  return {
    ok: envelope.ok,
    tool: envelope.tool,
    headline: inputs.headline,
    visuals: inputs.visuals ?? [],
    facts: inputs.facts ?? [],
    diagnostics,
    provenance: {
      tool: envelope.tool,
      toolVersion: envelope.toolVersion,
      backendVersion: envelope.backendVersion,
      durationMs: envelope.durationMs,
      inputHashes: envelope.inputHashes ?? {},
      outputHashes: envelope.outputHashes ?? {},
    },
    artifacts: (envelope.artifacts ?? []).map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      sha256: entry.sha256,
      role: inputs.artifactRoles?.[entry.kind],
    })),
  };
}

/** JSON-safe projection for `details` and (Phase 8) the observation index. */
export function bundleToRecord(bundle: ObservationBundle): Record<string, unknown> {
  return JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
}
