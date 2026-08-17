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
  defaultGeometryEvidencePath,
  defaultVisualEvidenceDir,
  envelopeArtifactHash,
  exportArtifact,
  geometryPayload,
  inspectGeometry,
  inspectVisual,
  readImageContents,
  visualPayload,
} from "../shared/capability.ts";
import type { CadProjectState } from "../shared/protocol.ts";
import {
  cloneState,
  nowIso,
  sha256File,
  type ProjectStateStore,
} from "../shared/store.ts";
import {
  acceptCandidate,
  addEvidence,
  evidenceFromBuild,
  evidenceFromEnvelope,
  markEvidenceStale,
} from "./state-machine.ts";

export type PersistFn = (
  pi: ExtensionAPI,
  store: ProjectStateStore,
  state: CadProjectState,
  events: Array<{ type: string; data?: unknown }>,
) => Promise<void>;

export interface AutoActionResult {
  state: CadProjectState;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  warnings: string[];
}

export async function runBaselineAuto(
  pi: ExtensionAPI,
  store: ProjectStateStore,
  state: CadProjectState,
  artifactRel: string,
  persist: PersistFn,
): Promise<AutoActionResult> {
  const cwd = store.cwd;
  const artifactAbs = resolve(cwd, artifactRel);
  const artifactHash = await sha256File(artifactAbs);
  const visualDir = defaultVisualEvidenceDir(cwd, artifactAbs);
  const geometryPath = defaultGeometryEvidencePath(cwd, artifactAbs);
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
  if (next.workflow === "release") {
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
  store: ProjectStateStore,
  state: CadProjectState,
  source: string,
  label: string,
  persist: PersistFn,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  const cwd = store.cwd;
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const output = defaultBuildOutput(cwd, source);
  const buildEnvelope = await buildStep(cwd, { source, output, force: true });
  if (!buildEnvelope.ok) {
    return {
      ok: false,
      text: `Candidate build failed. The workflow remains in ${state.phase.toUpperCase()}.\n${buildPayload(buildEnvelope).error ?? "unknown build error"}\n${buildPayload(buildEnvelope).stderr ?? ""}`,
      details: { envelope: buildEnvelope, sourceHash },
    };
  }

  const stepPath = artifactPathForKind(buildEnvelope, "step") ?? output;
  const artifactHash =
    envelopeArtifactHash(buildEnvelope, "step") ?? (await sha256File(stepPath));
  const visualDir = defaultVisualEvidenceDir(cwd, stepPath);
  const geometryPath = defaultGeometryEvidencePath(cwd, stepPath);

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

  if (
    (state.workflow === "modify" || state.workflow === "convert") &&
    state.baselineArtifactPath &&
    existsSync(resolve(cwd, state.baselineArtifactPath))
  ) {
    const compareOutput = resolve(
      cwd,
      ".pi-cad",
      "evidence",
      "compare",
      `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
    );
    const compareEnvelope = await compareGeometry(cwd, state.baselineArtifactPath, stepPath, compareOutput);
    if (compareEnvelope.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("compare", "cad_compare_geometry", compareEnvelope, artifactHash, sourceHash),
      );
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
    `Candidate ${label} committed. Harness executed build, visual, geometry${
      (state.workflow === "modify" || state.workflow === "convert") && state.baselineArtifactPath
        ? ", compare"
        : ""
    }.`,
    `- ${buildEnvelope.ok ? "build: ok" : "build: failed"}`,
    `- ${visualEnvelope.ok ? "visual: ok" : "visual: failed"}`,
    `- ${geometryEnvelope.ok ? "geometry: ok" : "geometry: failed"}`,
    `artifactHash=${artifactHash.slice(0, 12)}`,
    `sourceHash=${sourceHash.slice(0, 12)}`,
    ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
    "",
    `Phase is ${next.phase.toUpperCase()}. Inspect the attached current-version images yourself.`,
  ].join("\n");
  return { ok: true, text: summary, images, details: { state: next, envelope: buildEnvelope } };
}

export async function runConvertCandidateAuto(
  pi: ExtensionAPI,
  store: ProjectStateStore,
  state: CadProjectState,
  source: string,
  label: string,
  format: string,
  output: string,
  persist: PersistFn,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  const cwd = store.cwd;
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const outputAbs = resolve(cwd, output);
  const exportEnvelope = await exportArtifact(cwd, { source, output, format });
  if (!exportEnvelope.ok) {
    return {
      ok: false,
      text: `Conversion export failed: ${String(exportEnvelope.payload.error ?? "unknown error")}`,
    };
  }
  const artifactHash =
    envelopeArtifactHash(exportEnvelope, format) ?? (await sha256File(outputAbs));

  let next = markEvidenceStale(cloneState(state));
  const warnings: string[] = [];
  const events: Array<{ type: string; data?: unknown }> = [
    { type: "ConversionRequested", data: { source, format, output } },
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
    const visualAfter = await inspectVisual(cwd, outputAbs, defaultVisualEvidenceDir(cwd, outputAbs));
    if (visualAfter.ok) {
      next = addEvidence(
        next,
        evidenceFromEnvelope("visual", "cad_inspect_visual", visualAfter, artifactHash, sourceHash),
      );
      events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
    } else {
      warnings.push(`converted visual failed: ${String(visualPayload(visualAfter).error ?? "unknown")}`);
    }
    const geometryAfter = await inspectGeometry(cwd, outputAbs, defaultGeometryEvidencePath(cwd, outputAbs));
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
      resolve(cwd, ".pi-cad", "evidence", "compare", `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
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
    `source=${source} output=${output} format=${format}`,
    `artifactHash=${artifactHash.slice(0, 12)}`,
    ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
    `Phase is ${next.phase.toUpperCase()}.`,
  ].join("\n");
  return { ok: true, text, details: { state: next, envelope: exportEnvelope } };
}
