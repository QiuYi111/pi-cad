import { canonicalDigest, jsonValue, type JsonValue } from "../harness/canonical.ts";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { reviseEvidenceRef } from "../harness/reducer.ts";
import { HarnessRunStoreV7 } from "../harness/run-store.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { annotationsForChangedFaces, changedFaces, summarizeBuildChanges, type FaceFingerprint, type FeatureChanges } from "../modules/model/build-changes.ts";
import type { GeometryPayload } from "../shared/protocol.ts";
import { FULL_GEOMETRY_VALIDATION_TIMEOUT_MS, inspectGeometry, inspectVisual, runGeometryEvidencePath, runVisualEvidenceDir, visualPayload } from "../shared/capability.ts";
import { resolveActiveRun } from "../harness/run-scope.ts";
import { harnessStorageRoot } from "../authority/storage.ts";
import { sha256File } from "../shared/hash.ts";
import {
  normalizeModelParameterDefinitions,
  type ModelParameterManifestV1,
  type StoredModelParameterManifest,
} from "../shared/model-parameters.ts";

export function projectRelativePath(cwd: string, path: string): string {
  const value = relative(resolve(cwd), resolve(cwd, path));
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`managed CAD output escaped the project root: ${path}`);
  }
  return value.replaceAll("\\", "/");
}

function phaseCardEvidenceRef(cwd: string, path: string): string {
  const project = relative(resolve(cwd), resolve(path));
  if (project !== ".." && !project.startsWith(`..${sep}`) && !isAbsolute(project)) return project.replaceAll("\\", "/");
  const storage = relative(resolve(harnessStorageRoot(cwd)), resolve(path));
  if (storage === ".." || storage.startsWith(`..${sep}`) || isAbsolute(storage)) {
    throw new Error(`managed CAD evidence escaped canonical storage: ${path}`);
  }
  return `@canonical/${storage.replaceAll("\\", "/")}`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

type ActiveRun = NonNullable<Awaited<ReturnType<typeof resolveActiveRun>>>;

export interface ObserveCandidateInput {
  /** Project-relative STEP path. */
  artifact: string;
  /** Project-relative source: a build123d `.py` file or a FreeCAD `.FCStd` file. */
  sourcePath: string;
  sourceHash: string;
  /** SHA-256 of the STEP file; computed from the file when omitted. */
  artifactHash?: string;
  validation: "auto" | "fast" | "full";
  importMode?: "reference" | "solidify";
  parameters?: ReturnType<typeof normalizeModelParameterDefinitions>;
  highlight?: FaceFingerprint[];
  annotations?: Array<{ text: string; at: [number, number, number] }>;
  backend: "build123d" | "freecad";
  /** Feature-level facts only the FreeCAD backend can supply. */
  extraChanges?: FeatureChanges;
  /** Extra evidence envelopes, e.g. the build step, kept for the caller. */
  build?: unknown;
}

/** A change touching most faces says nothing useful when coloured; keep the shading instead. */
const MAX_HIGHLIGHT_FRACTION = 0.6;

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Everything that happens to a freshly produced STEP candidate, whichever
 * backend made it: geometry check, change summary against the previous build
 * of the same output, the seven mandatory views (changed faces highlighted),
 * and evidence registration.
 */
export async function observeCandidate(cwd: string, active: ActiveRun, input: ObserveCandidateInput) {
  const importingReference = input.importMode === "reference";
  const artifact = input.artifact;
  const geometryPath = runGeometryEvidencePath(cwd, active.state.runId, artifact);
  // The previous build of this output left its geometry evidence here. Read it
  // before inspecting, because inspecting overwrites the file.
  const previousGeometry = await readJsonOrNull<GeometryPayload>(geometryPath);
  const baselineSha256 = previousGeometry ? await sha256File(geometryPath) : undefined;
  const geometry = await inspectGeometry(
    cwd,
    artifact,
    geometryPath,
    input.validation === "full" ? FULL_GEOMETRY_VALIDATION_TIMEOUT_MS : undefined,
    input.validation,
  );
  if (!geometry.ok) {
    const payload = geometry.payload as { error?: string } | undefined;
    throw new Error(payload?.error || "Pi-CAD built the model but mandatory geometry inspection failed");
  }
  const geometryPayload = geometry.payload as GeometryPayload & { validity?: { ok?: boolean; reasons?: string[]; checks?: { topology?: boolean }; solids?: Array<{ reasons?: string[] }> } };
  const validity = geometryPayload.validity;
  if (importingReference && (!validity?.checks?.topology || !geometryPayload.faceCount)) {
    throw new Error("STEP reference import failed: the file has no valid displayable B-Rep faces");
  }
  if (!importingReference && !validity?.ok) {
    const reasons = [
      ...(validity?.reasons ?? []),
      ...(validity?.solids ?? []).flatMap((solid) => solid.reasons ?? []),
    ];
    throw new Error(`Pi-CAD built the model but generic B-Rep validation failed${reasons.length ? `: ${[...new Set(reasons)].join(", ")}` : ""}`);
  }

  const changes = summarizeBuildChanges(importingReference ? null : previousGeometry, geometryPayload, { ...input.extraChanges, ...(baselineSha256 ? { baselineSha256 } : {}) });
  const changed = input.highlight ?? changedFaces(importingReference ? null : previousGeometry, geometryPayload);
  const highlight = changed.length > 0 && changed.length < MAX_HIGHLIGHT_FRACTION * (geometryPayload.faceCount ?? Infinity) ? changed : [];
  const manifest = highlight.length && !input.annotations
    ? await readJsonOrNull<Parameters<typeof annotationsForChangedFaces>[0]>(`${resolve(cwd, artifact)}.identity.json`)
    : null;
  const annotations = input.annotations ?? annotationsForChangedFaces(manifest, highlight);

  const visual = await inspectVisual(cwd, artifact, runVisualEvidenceDir(cwd, active.state.runId, artifact), {
    ...(highlight.length ? { highlight } : {}),
    ...(annotations.length ? { annotations } : {}),
  });
  if (!visual.ok) {
    const payload = visual.payload as { error?: string } | undefined;
    throw new Error(payload?.error || "Pi-CAD built the model but mandatory visual inspection failed");
  }
  const views = visualPayload(visual).views ?? [];
  if (!views.length) throw new Error("Pi-CAD built the model but mandatory visual inspection produced no images");

  // Attach the complete seven-view set to the build result so both Prime and
  // the desktop activity card can inspect the same orientation-complete
  // observation.  Phase Cards still carry only the bounded ISO/FRONT pair.
  const contextRefs = Object.fromEntries(views.map((view) => [
    `mandatoryImage${view.name.charAt(0).toUpperCase()}${view.name.slice(1)}`,
    phaseCardEvidenceRef(cwd, view.path),
  ]));
  const artifactHash = input.artifactHash ?? await sha256File(resolve(cwd, artifact));
  const referenceType = importingReference ? (geometryPayload.solidCount ? "solid-reference" : "surface-reference") : undefined;
  const sourcePath = input.sourcePath;
  const sourceHash = input.sourceHash;
  let parameterManifest: StoredModelParameterManifest | undefined;
  if (input.parameters) {
    const outputPath = projectRelativePath(cwd, artifact);
    const modelId = `model-${canonicalDigest({ source: sourcePath, output: outputPath }).slice(0, 20)}`;
    const manifest: ModelParameterManifestV1 = {
      schema: 1,
      modelId,
      source: { path: sourcePath, sha256: sourceHash, entrypoint: "build" },
      output: { path: outputPath, sha256: artifactHash },
      parameters: input.parameters.parameters,
    };
    const manifestPath = `${resolve(cwd, artifact)}.parameters.json`;
    await writeJsonAtomic(manifestPath, manifest);
    parameterManifest = {
      path: projectRelativePath(cwd, manifestPath),
      sha256: await sha256File(manifestPath),
      manifest,
    };
  }
  if (!importingReference) await new HarnessRunStoreV7(cwd, active.state.runId).mutate(mechanicalRegistries, (loaded) => {
    let state = {
      ...loaded.state,
      artifacts: {
        ...loaded.state.artifacts,
        "candidate:authoritative": { id: "candidate:authoritative", path: projectRelativePath(cwd, artifact), sha256: artifactHash, role: "authoritative-candidate-design" },
        "candidate:source": { id: "candidate:source", path: sourcePath, sha256: sourceHash, role: "candidate-source" },
        ...(parameterManifest ? {
          [`model-parameters:${parameterManifest.manifest.modelId}`]: {
            id: `model-parameters:${parameterManifest.manifest.modelId}`,
            path: parameterManifest.path,
            sha256: parameterManifest.sha256,
            role: "model-parameter-manifest",
          },
        } : {}),
      },
      contextRefs: { ...loaded.state.contextRefs, ...contextRefs },
    };
    const payloads: Record<string, JsonValue> = {};
    const envelopes = new Map([["visual", visual], ["geometry", geometry]]);
    for (const obligation of loaded.workflow.phases[state.phase]!.evidenceObligations.filter((item) => item.closeWith === "cad_build_step")) {
      const envelope = envelopes.get(obligation.type);
      if (!envelope) throw new Error(`cad.model.build cannot produce required ${obligation.type} evidence`);
      const sha256 = canonicalDigest(envelope);
      const evidence = {
        id: `evidence-${obligation.type}-${sha256.slice(0, 20)}`,
        obligationRef: obligation.ref, type: obligation.type,
        path: `evidence/${obligation.type}/evidence-${obligation.type}-${sha256.slice(0, 20)}.json`,
        sha256, workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash,
        computeIdentity: canonicalDigest({ tool: envelope.tool, toolVersion: envelope.toolVersion, inputHashes: envelope.inputHashes, outputHashes: envelope.outputHashes }),
        createdAt: new Date().toISOString(),
      };
      state = reviseEvidenceRef(state, loaded.workflow, loaded.registryContract, evidence);
      payloads[evidence.path] = jsonValue({ schema: 1, evidence, envelope });
    }
    return {
      state,
      payloads,
      event: { type: "ModelBuildObserved", data: { artifact: projectRelativePath(cwd, artifact), images: Object.values(contextRefs), evidence: [...envelopes.keys()], backend: input.backend } },
    };
  });
  const inlineImages = await Promise.all(views.map(async (view) => ({
    name: view.name,
    data: (await readFile(view.path)).toString("base64"),
    mimeType: "image/png",
  })));
  return {
    visual, geometry, images: inlineImages, changes, highlighted: highlight.length > 0,
    ...(referenceType ? { referenceType } : {}), ...(parameterManifest ? { parameterManifest } : {}),
  };
}
