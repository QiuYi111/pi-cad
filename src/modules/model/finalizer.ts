/**
 * Candidate finalizer (refactor Phase 4).
 *
 * Splits candidate handling into:
 *
 *   1. MODEL execution — buildProposal / convertProposal produce a
 *      CandidateProposal (execute source, hash the artifact). This is
 *      the part a future ModelBackend owns (Phase 5).
 *   2. Review lifecycle — finalizeCandidate / finalizeConversion run the
 *      automatic observation set, bind evidence, accept the candidate
 *      through the state machine, write the manifest, and persist.
 *
 * MODEL never decides acceptance; the finalizer never executes geometry
 * itself. Text output is byte-compatible with the pre-split
 * auto-actions (workflows-full tests are the oracle).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

import {
  artifactPathForKind,
  assemblyTree,
  buildPayload,
  buildStep,
  compareGeometry,
  defaultBuildOutput,
  envelopeArtifactHash,
  exportArtifact,
  geometryPayload,
  inspectGeometry,
  inspectInterference,
  inspectVisual,
  readImageContents,
  runAssemblyEvidencePath,
  runCompareEvidencePath,
  runGeometryEvidencePath,
  runInterferenceEvidencePath,
  runVisualEvidenceDir,
  visualPayload,
} from "../../shared/capability.ts";
import type { CadEventEnvelope, CadRunState } from "../../shared/protocol.ts";
import {
  CadProjectStore,
  cloneState,
  nowIso,
  sha256File,
} from "../../shared/store.ts";
import {
  acceptCandidate,
  addEvidence,
  evidenceFromBuild,
  evidenceFromEnvelope,
  markEvidenceStale,
} from "../../core/state-machine.ts";
import type { PersistFn } from "../../core/auto-actions.ts";

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
): Promise<ProposalResult> {
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const output = defaultBuildOutput(cwd, source);
  const envelope = await buildStep(cwd, { source, output, force: true });
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
): Promise<ProposalResult> {
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const outputAbs = resolve(cwd, output);
  const envelope = await exportArtifact(cwd, { source, output, format });
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

// ---------------------------------------------------------------------------
// Review lifecycle
// ---------------------------------------------------------------------------

/** Design-candidate finalize: visual/geometry(+assembly/interference/compare) evidence + accept. */
export async function finalizeCandidate(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  proposal: CandidateProposal,
  persist: PersistFn,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  const cwd = store.cwd;
  const { source, sourceHash, label, artifactHash } = proposal;
  const stepPath = proposal.artifactPath;
  const buildEnvelope = proposal.envelope;
  const visualDir = runVisualEvidenceDir(cwd, state.runId, stepPath);
  const geometryPath = runGeometryEvidencePath(cwd, state.runId, stepPath);

  let next = markEvidenceStale(cloneState(state));
  next = addEvidence(next, evidenceFromBuild(buildEnvelope, artifactHash, sourceHash));
  const warnings: string[] = [];
  const events: Array<{ type: string; data?: unknown }> = [
    { type: "SourceChanged", data: { source, sourceHash } },
    { type: "ArtifactBuilt", data: { artifact: stepPath, artifactHash } },
  ];

  const visualEnvelope = await inspectVisual(cwd, stepPath, visualDir);
  if (visualEnvelope.ok) {
    next = addEvidence(
      next,
      evidenceFromEnvelope("visual", "cad_inspect_visual", visualEnvelope, artifactHash, sourceHash),
    );
    events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
  } else {
    warnings.push(`visual auto-action failed: ${visualPayload(visualEnvelope).error ?? "unknown error"}`);
  }

  const geometryEnvelope = await inspectGeometry(cwd, stepPath, geometryPath);
  if (geometryEnvelope.ok) {
    next = addEvidence(
      next,
      evidenceFromEnvelope("geometry", "cad_inspect_geometry", geometryEnvelope, artifactHash, sourceHash),
    );
    events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
  } else {
    warnings.push(`geometry auto-action failed: ${geometryPayload(geometryEnvelope).error ?? "unknown error"}`);
  }

  // Assembly structure routes owe assembly-tree and interference evidence
  // for the current candidate version; the harness observes the facts
  // automatically, the Agent interprets them at integration review.
  let assemblyRecorded = false;
  let interferenceRecorded = false;
  if (state.route?.objective === "design" && state.route.structure === "assembly") {
    const treeEnvelope = await assemblyTree(cwd, stepPath, runAssemblyEvidencePath(cwd, state.runId, stepPath));
    if (treeEnvelope.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("assembly", "cad_assembly_tree", treeEnvelope, artifactHash, sourceHash),
      );
      assemblyRecorded = true;
      events.push({ type: "EvidenceCreated", data: { kind: "assembly", artifactHash } });
    } else {
      warnings.push(`assembly tree auto-action failed: ${String(treeEnvelope.payload.error ?? "unknown error")}`);
    }
    const interferencePath = runInterferenceEvidencePath(cwd, state.runId, stepPath);
    const interferenceEnvelope = await inspectInterference(cwd, stepPath, interferencePath);
    if (interferenceEnvelope.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("interference", "cad_inspect_interference", interferenceEnvelope, artifactHash, sourceHash),
      );
      interferenceRecorded = true;
      events.push({ type: "EvidenceCreated", data: { kind: "interference", artifactHash } });
    } else {
      warnings.push(`interference auto-action failed: ${String(interferenceEnvelope.payload.error ?? "unknown error")}`);
    }
  }

  let compareRecorded = false;
  if (
    wantsCompareEvidence(state) &&
    state.baselineArtifactPath &&
    existsSync(resolve(cwd, state.baselineArtifactPath))
  ) {
    const compareOutput = runCompareEvidencePath(cwd, state.runId, label);
    const compareEnvelope = await compareGeometry(cwd, state.baselineArtifactPath, stepPath, compareOutput);
    if (compareEnvelope.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("compare", "cad_compare_geometry", compareEnvelope, artifactHash, sourceHash),
      );
      compareRecorded = true;
      events.push({ type: "EvidenceCreated", data: { kind: "compare", artifactHash } });
    } else {
      warnings.push(`compare auto-action failed: ${compareEnvelope.payload.error ?? "unknown error"}`);
    }
  }

  const accepted = acceptCandidate(
    next,
    {
      label,
      sources: [source],
      sourceHashes: { [source]: sourceHash },
      sourcePath: source,
      artifactPath: stepPath,
    },
    artifactHash,
  );
  if (!accepted.ok) return { ok: false, text: accepted.reason };
  next = accepted.state;
  events.push(...accepted.events);

  await store.writeManifest({
    schemaVersion: 2,
    candidate: label,
    source,
    sourceHash,
    artifact: stepPath,
    artifactHash,
    evidence: next.evidence.map((ref) => ({
      kind: ref.kind,
      artifactHash: ref.artifactHash,
      ...(ref.specHash ? { specHash: ref.specHash } : {}),
      paths: ref.paths,
    })),
    warnings,
    updatedAt: nowIso(),
  });
  await persist(pi, store, next, events);

  const images = visualEnvelope.ok
    ? await readImageContents((visualPayload(visualEnvelope).views ?? []).map((view) => view.path))
    : [];
  const summary = [
    `Candidate ${label} committed. Harness executed build, visual, geometry${assemblyRecorded ? ", assembly tree" : ""}${interferenceRecorded ? ", interference" : ""}${compareRecorded ? ", compare" : ""}.`,
    `- ${buildEnvelope.ok ? "build: ok" : "build: failed"}`,
    `- ${visualEnvelope.ok ? "visual: ok" : "visual: failed"}`,
    `- ${geometryEnvelope.ok ? "geometry: ok" : "geometry: failed"}`,
    ...(geometryEnvelope.ok ? [`- facts: ${geometryDigest(geometryEnvelope)}`] : []),
    `artifactHash=${artifactHash.slice(0, 12)}`,
    `sourceHash=${sourceHash.slice(0, 12)}`,
    ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
    "",
    `Phase is ${next.phase.toUpperCase()}. Inspect the attached current-version images yourself.`,
  ].join("\n");
  return { ok: true, text: summary, images, details: { state: next, envelope: buildEnvelope } };
}

/** Convert-candidate finalize: convert evidence (+assembly/visual/geometry/compare for STEP). */
export async function finalizeConversion(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  proposal: CandidateProposal,
  persist: PersistFn,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  const cwd = store.cwd;
  const { source, sourceHash, label, artifactHash } = proposal;
  const outputAbs = proposal.artifactPath;
  const exportEnvelope = proposal.envelope;

  let next = markEvidenceStale(cloneState(state));
  const warnings: string[] = [];
  const events: Array<{ type: string; data?: unknown }> = [
    { type: "ConversionRequested", data: { source, format: proposal.format, output: proposal.output } },
  ];
  next = addEvidence(
    next,
    evidenceFromEnvelope("convert", "cad_export", exportEnvelope, artifactHash, sourceHash),
  );
  events.push({ type: "EvidenceCreated", data: { kind: "convert", artifactHash } });

  const assemblyBefore = await assemblyTree(cwd, source);
  if (assemblyBefore.ok) {
    next = addEvidence(
      next,
      evidenceFromEnvelope("assembly", "cad_assembly_tree", assemblyBefore, sourceHash),
    );
    events.push({ type: "EvidenceCreated", data: { kind: "assembly", artifactHash: sourceHash } });
  } else {
    warnings.push(`source assembly-tree failed: ${String(assemblyBefore.payload.error ?? "unknown")}`);
  }

  if ([".step", ".stp"].includes(extname(outputAbs).toLowerCase())) {
    const assemblyAfter = await assemblyTree(cwd, outputAbs);
    if (assemblyAfter.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("assembly", "cad_assembly_tree", assemblyAfter, artifactHash),
      );
      events.push({ type: "EvidenceCreated", data: { kind: "assembly", artifactHash } });
    } else {
      warnings.push(`converted assembly-tree failed: ${String(assemblyAfter.payload.error ?? "unknown")}`);
    }
    const visualAfter = await inspectVisual(cwd, outputAbs, runVisualEvidenceDir(cwd, state.runId, outputAbs));
    if (visualAfter.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("visual", "cad_inspect_visual", visualAfter, artifactHash, sourceHash),
      );
      events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
    } else {
      warnings.push(`converted visual failed: ${String(visualPayload(visualAfter).error ?? "unknown")}`);
    }
    const geometryAfter = await inspectGeometry(cwd, outputAbs, runGeometryEvidencePath(cwd, state.runId, outputAbs));
    if (geometryAfter.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("geometry", "cad_inspect_geometry", geometryAfter, artifactHash, sourceHash),
      );
      events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
    } else {
      warnings.push(`converted geometry failed: ${String(geometryPayload(geometryAfter).error ?? "unknown")}`);
    }
    const compareEnv = await compareGeometry(
      cwd,
      source,
      outputAbs,
      runCompareEvidencePath(cwd, state.runId, label),
    );
    if (compareEnv.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("compare", "cad_compare_geometry", compareEnv, artifactHash, sourceHash),
      );
      events.push({ type: "EvidenceCreated", data: { kind: "compare", artifactHash } });
    } else {
      warnings.push(`converted compare failed: ${String(compareEnv.payload.error ?? "unknown")}`);
    }
  }

  const accepted = acceptCandidate(
    next,
    {
      label,
      sources: [source],
      sourceHashes: { [source]: sourceHash },
      sourcePath: source,
      artifactPath: outputAbs,
    },
    artifactHash,
  );
  if (!accepted.ok) return { ok: false, text: accepted.reason };
  next = accepted.state;
  events.push(...accepted.events);
  await persist(pi, store, next, events);

  const text = [
    `Conversion candidate ${label} committed.`,
    `source=${source} output=${proposal.output} format=${proposal.format}`,
    `artifactHash=${artifactHash.slice(0, 12)}`,
    ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
    `Phase is ${next.phase.toUpperCase()}.`,
  ].join("\n");
  return { ok: true, text, details: { state: next, envelope: exportEnvelope } };
}

// ---------------------------------------------------------------------------
// Shared helpers (moved verbatim from auto-actions)
// ---------------------------------------------------------------------------

function wantsCompareEvidence(state: CadRunState): boolean {
  const route = state.route;
  if (!route) return false;
  if (route.objective === "convert") return true;
  if (route.objective !== "design") return false;
  return route.lineage === "legacy" || route.maturity === "release";
}

function geometryDigest(envelope: Parameters<typeof geometryPayload>[0]): string {
  const p = geometryPayload(envelope);
  const bbox = p.bbox ? `${p.bbox.x}×${p.bbox.y}×${p.bbox.z} ${p.units ?? ""}`.trim() : "?";
  const radii = (p.cylinders ?? [])
    .map((c) => (typeof c.radius === "number" ? `r=${c.radius}` : null))
    .filter((s): s is string => s !== null)
    .slice(0, 8);
  const parts = [
    `bbox=${bbox}`,
    `volume=${p.volume ?? "?"}`,
    `surfaceArea=${p.surfaceArea ?? "?"}`,
    `solids=${p.solidCount ?? "?"}`,
    `cylinders=${p.cylinders?.length ?? 0}${radii.length ? ` [${radii.join(", ")}]` : ""}`,
  ];
  return parts.join("; ");
}
