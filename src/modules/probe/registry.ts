/**
 * PROBE module registry (refactor Phase 2).
 *
 * One preset per deterministic observation capability. Existing agent
 * tools become thin wrappers over this registry (Phase 2), and the
 * unified `cad_probe` tool (Phase 3) exposes the same presets directly:
 *
 *     small interface, large implementation.
 *
 * A preset owns:
 *   - argument → cadctl invocation (via shared/capability.ts);
 *   - evidence output path policy (run-scoped when a run is active);
 *   - the evidence kind its observations may bind to (or none, for
 *     pure-observation presets);
 *   - a headline describing WHAT was observed (never engineering
 *     meaning).
 */
import type { CadEventEnvelope } from "../../shared/protocol.ts";
import { hashOrEmpty } from "../../shared/capability.ts";
import type { ObservationFact, ObservationVisual } from "../../observations/bundle.ts";
import { bundleToRecord } from "../../observations/bundle.ts";
import { observeContent } from "../../observations/renderer.ts";

export interface ProbeResult {
  envelope: CadEventEnvelope;
  /** Evidence kind this observation can bind to (omitted = observation only). */
  kind?: string;
  headline: string;
  /** Explicit facts (override the profile projection, e.g. surface selectors). */
  facts?: ObservationFact[];
  /** Explicit visuals (override the profile projection). */
  visuals?: ObservationVisual[];
  /** Raw envelope appended to agent output (default true for build-like presets). */
  includeEnvelope?: boolean;
  /** Artifact path used to backfill the artifact hash. */
  artifactPath?: string;
  /** Hash source override (e.g. compare binds to `after`). */
  artifactHashFrom?: "artifact" | "after" | "before" | "source";
  extraDetails?: Record<string, unknown>;
}

export interface ProbeContext {
  cwd: string;
}

export interface ProbePreset<A = Record<string, unknown>> {
  name: string;
  run(args: A, ctx: ProbeContext): Promise<ProbeResult>;
}

const REGISTRY = new Map<string, ProbePreset<never>>();

export function registerProbe(preset: ProbePreset<any>): void {
  if (REGISTRY.has(preset.name)) {
    throw new Error(`probe preset already registered: ${preset.name}`);
  }
  REGISTRY.set(preset.name, preset);
}

export function probePreset(name: string): ProbePreset<any> | undefined {
  return REGISTRY.get(name);
}

export function probePresetNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** Shared agent-facing rendering for every probe result. */
export async function renderProbeResult(
  result: ProbeResult,
  toolLabel?: string,
): Promise<{
  content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  details: Record<string, unknown>;
}> {
  if (!result.envelope.ok) {
    const error =
      typeof result.envelope.payload?.error === "string"
        ? result.envelope.payload.error
        : "unknown error";
    const prefix = toolLabel ?? "probe";
    return {
      content: [{ type: "text", text: `${prefix} failed: ${error}` }],
      details: {
        envelope: result.envelope,
        presetFailed: true,
        ...(result.extraDetails ?? {}),
      },
    };
  }

  const { content, bundle } = await observeContent(
    result.envelope,
    {
      headline: result.headline,
      ...(result.facts ? { facts: result.facts } : {}),
      ...(result.visuals ? { visuals: result.visuals } : {}),
    },
    { includeEnvelope: result.includeEnvelope === false ? null : result.envelope },
  );

  const artifactHash = await resolveArtifactHash(result);
  return {
    content,
    details: {
      envelope: result.envelope,
      observation: bundleToRecord(bundle),
      ...(artifactHash ? { artifactHash } : {}),
      ...(result.kind ? { kind: result.kind } : {}),
      ...(result.extraDetails ?? {}),
    },
  };
}

async function resolveArtifactHash(result: ProbeResult): Promise<string | undefined> {
  const from = result.artifactHashFrom ?? "artifact";
  const direct = result.envelope.inputHashes?.[from];
  if (direct) return direct;
  if (result.artifactPath) {
    const hash = await hashOrEmpty(result.artifactPath);
    if (hash) return hash;
  }
  return undefined;
}
