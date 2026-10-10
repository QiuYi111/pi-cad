/**
 * Candidate finalizer (MODEL side).
 *
 * buildProposal / convertProposal execute the candidate source (or export a
 * conversion) and hash the produced artifact into a CandidateProposal. This is
 * the part a ModelBackend owns. Acceptance, evidence and review belong to the
 * v7 harness (domains/mechanical/candidate-actions-v7.ts); the finalizer never
 * decides acceptance.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { artifactPathForKind, buildPayload, envelopeArtifactHash } from "../../shared/envelope.ts";
import { defaultBuildOutput } from "../../shared/cadctl/commands.ts";
import type { CadEventEnvelope } from "../../shared/protocol.ts";
import { sha256File } from "../../shared/hash.ts";
import { modelBackend, type ModelBackend } from "./backend.ts";

/** The MODEL→control-plane handoff object: what was produced, hashed. */
export interface CandidateProposal {
  kind: "build" | "convert";
  label: string;
  source: string;
  sourceHash: string;
  /** Absolute path of the produced artifact. */
  artifactPath: string;
  artifactHash: string;
  envelope: CadEventEnvelope;
  format?: string;
  output?: string;
}

export type ProposalResult =
  | { ok: true; proposal: CandidateProposal }
  | { ok: false; text: string; details?: unknown }
  /** Structured failure for callers that own the exact user-facing text. */
  | { ok: false; buildFailed: true; error: string; stderr: string; details?: unknown };

// ---------------------------------------------------------------------------
// MODEL execution
// ---------------------------------------------------------------------------

export async function buildProposal(
  cwd: string,
  source: string,
  label: string,
  backend: ModelBackend = modelBackend(),
): Promise<ProposalResult> {
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const output = defaultBuildOutput(cwd, source);
  const envelope = await backend.build(cwd, { source, output });
  if (!envelope.ok) {
    return {
      ok: false,
      buildFailed: true,
      error: buildPayload(envelope).error ?? "unknown build error",
      stderr: buildPayload(envelope).stderr ?? "",
      details: { envelope, sourceHash },
    };
  }
  const stepPath = artifactPathForKind(envelope, "step") ?? output;
  const artifactHash = envelopeArtifactHash(envelope, "step") ?? (await sha256File(stepPath));
  return {
    ok: true,
    proposal: {
      kind: "build",
      label,
      source,
      sourceHash,
      artifactPath: stepPath,
      artifactHash,
      envelope,
    },
  };
}

export async function convertProposal(
  cwd: string,
  source: string,
  label: string,
  format: string,
  output: string,
  backend: ModelBackend = modelBackend(),
): Promise<ProposalResult> {
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const outputAbs = resolve(cwd, output);
  const envelope = await backend.export(cwd, { source, output, format });
  if (!envelope.ok) {
    return {
      ok: false,
      text: `Conversion export failed: ${String(envelope.payload.error ?? "unknown error")}`,
    };
  }
  const artifactHash =
    envelopeArtifactHash(envelope, format) ?? (await sha256File(outputAbs));
  return {
    ok: true,
    proposal: {
      kind: "convert",
      label,
      source,
      sourceHash,
      artifactPath: outputAbs,
      artifactHash,
      envelope,
      format,
      output,
    },
  };
}
