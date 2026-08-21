import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  geometryPayload,
  inspectGeometry,
  inspectVisual,
  readImageContents,
  runGeometryEvidencePath,
  runVisualEvidenceDir,
  visualPayload,
} from "../shared/capability.ts";
import type { CadRunState } from "../shared/protocol.ts";
import {
  CadProjectStore,
  cloneState,
  sha256File,
} from "../shared/store.ts";
import {
  addEvidence,
  evidenceFromEnvelope,
} from "./state-machine.ts";
import {
  buildProposal,
  convertProposal,
  finalizeCandidate,
  finalizeConversion,
} from "../modules/model/finalizer.ts";

export type PersistFn = (
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  events: Array<{ type: string; data?: unknown }>,) => Promise<void>;

export interface AutoActionResult {
  state: CadRunState;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  warnings: string[];
}

export async function runBaselineAuto(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  artifactRel: string,
  persist: PersistFn,
): Promise<AutoActionResult> {
  const cwd = store.cwd;
  const artifactAbs = resolve(cwd, artifactRel);
  const artifactHash = await sha256File(artifactAbs);
  const visualDir = runVisualEvidenceDir(cwd, state.runId, artifactAbs);
  const geometryPath = runGeometryEvidencePath(cwd, state.runId, artifactAbs);
  const warnings: string[] = [];
  const events: Array<{ type: string; data?: unknown }> = [];

  let next = cloneState(state);
  next = {
    ...next,
    baselineSourcePath: /\.(step|stp)$/i.test(artifactRel) ? artifactRel : undefined,
    baselineSourceHash: /\.(step|stp)$/i.test(artifactRel) ? artifactHash : undefined,
    baselineArtifactPath: artifactRel,
    baselineArtifactHash: artifactHash,
  };
  if (next.route?.objective === "design" && next.route.maturity === "release") {
    next = {
      ...next,
      currentSourcePath: artifactRel,
      currentSourceHash: artifactHash,
      currentArtifactPath: artifactRel,
      currentArtifactHash: artifactHash,
    };
  }

  const visualEnvelope = await inspectVisual(cwd, artifactAbs, visualDir);
  if (visualEnvelope.ok) {
    next = addEvidence(
      next,
      evidenceFromEnvelope("visual", "cad_inspect_visual", visualEnvelope, artifactHash),
    );
    events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
  } else {
    warnings.push(`baseline visual auto-action failed: ${visualPayload(visualEnvelope).error ?? "unknown error"}`);
  }

  const geometryEnvelope = await inspectGeometry(cwd, artifactAbs, geometryPath);
  if (geometryEnvelope.ok) {
    next = addEvidence(
      next,
      evidenceFromEnvelope("geometry", "cad_inspect_geometry", geometryEnvelope, artifactHash),
    );
    events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
  } else {
    warnings.push(`baseline geometry auto-action failed: ${geometryPayload(geometryEnvelope).error ?? "unknown error"}`);
  }

  await persist(pi, store, next, [
    { type: "BaselineBound", data: { artifact: artifactRel, artifactHash } },
    ...events,
  ]);
  const images = visualEnvelope.ok
    ? await readImageContents((visualPayload(visualEnvelope).views ?? []).map((view) => view.path))
    : [];
  return { state: next, images, warnings };
}

export async function runCandidateAuto(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  source: string,
  label: string,
  persist: PersistFn,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  // Phase 4: MODEL execution is now a proposal; the review lifecycle
  // lives in the candidate finalizer. This wrapper preserves the exact
  // pre-split user-facing text.
  const built = await buildProposal(store.cwd, source, label);
  if (!built.ok) {
    if ("buildFailed" in built) {
      return {
        ok: false,
        text: `Candidate build failed. The workflow remains in ${state.phase.toUpperCase()}.\n${built.error}\n${built.stderr}`,
        details: built.details,
      };
    }
    return built;
  }
  return finalizeCandidate(pi, store, state, built.proposal, persist);
}

export async function runConvertCandidateAuto(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  source: string,
  label: string,
  format: string,
  output: string,
  persist: PersistFn,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  // Phase 4: conversion MODEL execution + finalizer, text-compatible.
  const converted = await convertProposal(store.cwd, source, label, format, output);
  if (!converted.ok) return converted;
  return finalizeConversion(pi, store, state, converted.proposal, persist);
}
