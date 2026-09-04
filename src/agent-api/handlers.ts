import { canonicalDigest, jsonValue, type JsonValue } from "../harness/canonical.ts";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commitWorkspace, loadWorkspaceCommit, workspaceHistory } from "../harness/commit.ts";
import { reviseEvidenceRef, transitionRun } from "../harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { executeCadProbe } from "../modules/probe/tool.ts";
import { artifactPathForKind, buildStep, envelopeArtifactHash, inspectGeometry, inspectVisual, runGeometryEvidencePath, runVisualEvidenceDir, visualPayload } from "../shared/capability.ts";
import { executeMechanicalRecipeV7 } from "../domains/mechanical/recipe-actions-v7.ts";
import { cadStartSnapshot } from "../harness/kernel.ts";
import { discoverWorkflowPackages, resolveWorkflowPackage } from "../harness/workflow/packages.ts";
import type { AgentApiRequest } from "./protocol.ts";
import { bootstrapAgentApiContracts } from "./bootstrap.ts";
import { requireCurrentAuthorization } from "./authorization.ts";
import type { Operation, OperationAuthority } from "../harness/permissions.ts";
import { harnessStorageRoot } from "../authority/storage.ts";
import { workflowCurrentView } from "../harness/card.ts";
import { sha256File } from "../shared/store.ts";
import {
  normalizeModelParameterDefinitions,
  type ModelParameterManifestV1,
  type StoredModelParameterManifest,
} from "../shared/model-parameters.ts";

/**
 * Every Agent API operation that can mutate an active run is admitted here,
 * before its handler is selected. workflow-start is the sole bootstrap
 * exception because no workflow state exists yet to authorize it.
 */
export const AGENT_API_MUTATION_OPERATIONS = {
  "workflow-advance": "workflow.transition",
  commit: "workspace.commit",
  probe: "probe.run",
  "model-build": "model.build",
  "simulation-run": "simulation.run",
  "review-submit": "review.submit",
} as const satisfies Partial<Record<AgentApiRequest["op"], Operation>>;

async function current(cwd: string) {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!loaded) return null;
  return workflowCurrentView(loaded, mechanicalRegistries);
}

async function viewerCatalog(cwd: string) {
  const project = new HarnessProjectStoreV7(cwd);
  const [{ state: projectState }, active] = await Promise.all([
    project.load(),
    project.currentRun(mechanicalRegistries),
  ]);
  const commits = active ? await workspaceHistory(cwd, mechanicalRegistries) : [];
  const simulationRuns: JsonValue[] = [];
  const parameterManifests: StoredModelParameterManifest[] = [];
  if (active) {
    for (const [key, resultId] of Object.entries(active.state.domainMetadata ?? {})) {
      if (!key.startsWith("recipe-result:") || typeof resultId !== "string") continue;
      const result = await new HarnessRunStoreV7(cwd, active.state.runId).transactions.readJson<{
        run?: { runId?: string; recipeId?: string; recipeKind?: string; status?: string; createdAt?: string; completedAt?: string };
        observation?: { observationId?: string; exports?: Array<{ name: string; type: string; value?: number; unit?: string; path?: string; sha256?: string }> };
      }>(`records/recipe-results/${resultId}.json`);
      if (!result?.run || result.run.recipeKind !== "simulation") continue;
      simulationRuns.push(jsonValue({
        id: result.run.runId ?? key.slice("recipe-result:".length),
        recipeId: result.run.recipeId ?? "simulation",
        status: result.run.status ?? "completed",
        observationId: result.observation?.observationId ?? null,
        createdAt: result.run.createdAt ?? null,
        completedAt: result.run.completedAt ?? null,
        outputs: (result.observation?.exports ?? []).map((output) => ({
          ...output,
          ...(output.path ? { path: `.pi-cad/runs/${active.state.runId}/recipe-runs/${result.run!.runId}/workspace/${output.path}` } : {}),
        })),
      }));
    }
  }
  const parameterArtifacts = [
    ...Object.values(active?.state.artifacts ?? {}),
    ...Object.values(projectState.head.artifacts),
  ];
  const seenParameterArtifacts = new Set<string>();
  for (const artifact of parameterArtifacts) {
    const identity = `${artifact.path}\0${artifact.sha256}`;
    if (seenParameterArtifacts.has(identity)) continue;
    seenParameterArtifacts.add(identity);
    if (artifact.role !== "model-parameter-manifest") continue;
    try {
      const path = projectRelativePath(cwd, artifact.path);
      const absolute = resolve(cwd, path);
      if (await sha256File(absolute) !== artifact.sha256) continue;
      const manifest = JSON.parse(await readFile(absolute, "utf8")) as ModelParameterManifestV1;
      if (manifest.schema !== 1 || !Array.isArray(manifest.parameters)) continue;
      const sourcePath = resolve(cwd, projectRelativePath(cwd, manifest.source.path));
      const outputPath = resolve(cwd, projectRelativePath(cwd, manifest.output.path));
      if (await sha256File(sourcePath) !== manifest.source.sha256) continue;
      if (await sha256File(outputPath) !== manifest.output.sha256) continue;
      parameterManifests.push({ path, sha256: artifact.sha256, manifest });
    } catch {
      // A loose, stale, or user-edited sidecar has no workflow authority.
    }
  }
  return jsonValue({
    projectId: projectState.projectId,
    projectHead: { updatedAt: projectState.head.updatedAt, artifacts: Object.values(projectState.head.artifacts) },
    currentRun: active ? {
      id: active.state.runId,
      phase: active.state.phase,
      status: active.state.status,
      updatedAt: active.state.updatedAt,
      artifacts: Object.values(active.state.artifacts),
    } : null,
    commits,
    simulationRuns,
    parameterManifests,
  });
}

function projectRelativePath(cwd: string, path: string): string {
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

async function buildAndObserve(cwd: string, request: Extract<AgentApiRequest, { op: "model-build" }>) {
  const activeBeforeBuild = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!activeBeforeBuild) throw new Error("model.build authorization lost its active workflow");
  const parameterContract = request.parameters
    ? normalizeModelParameterDefinitions(request.parameters)
    : undefined;
  const build = await buildStep(cwd, {
    source: request.source,
    output: request.output,
    force: request.force,
    parameters: parameterContract?.values,
  });
  if (!build.ok) return { build, visual: null, images: [] };

  const artifact = artifactPathForKind(build, "step") ?? request.output;
  const geometry = await inspectGeometry(cwd, artifact, runGeometryEvidencePath(cwd, activeBeforeBuild.state.runId, artifact));
  if (!geometry.ok) {
    const payload = geometry.payload as { error?: string } | undefined;
    throw new Error(payload?.error || "Pi-CAD built the model but mandatory geometry inspection failed");
  }
  const validity = (geometry.payload as { validity?: { ok?: boolean; reasons?: string[]; solids?: Array<{ reasons?: string[] }> } }).validity;
  if (!validity?.ok) {
    const reasons = [
      ...(validity?.reasons ?? []),
      ...(validity?.solids ?? []).flatMap((solid) => solid.reasons ?? []),
    ];
    throw new Error(`Pi-CAD built the model but generic B-Rep validation failed${reasons.length ? `: ${[...new Set(reasons)].join(", ")}` : ""}`);
  }
  const visual = await inspectVisual(cwd, artifact, runVisualEvidenceDir(cwd, activeBeforeBuild.state.runId, artifact));
  if (!visual.ok) {
    const payload = visual.payload as { error?: string } | undefined;
    throw new Error(payload?.error || "Pi-CAD built the model but mandatory visual inspection failed");
  }
  const views = visualPayload(visual).views ?? [];
  if (!views.length) throw new Error("Pi-CAD built the model but mandatory visual inspection produced no images");
  const images = views.map((view) => view.path);

  // Attach the complete seven-view set to the build result so both Prime and
  // the desktop activity card can inspect the same orientation-complete
  // observation.  Phase Cards still carry only the bounded ISO/FRONT pair.
  const contextRefs = Object.fromEntries(views.map((view) => [
    `mandatoryImage${view.name.charAt(0).toUpperCase()}${view.name.slice(1)}`,
    phaseCardEvidenceRef(cwd, view.path),
  ]));
  const artifactHash = envelopeArtifactHash(build, "step");
  if (!artifactHash) throw new Error("Pi-CAD model build lacks an authoritative STEP hash");
  const sourcePath = projectRelativePath(cwd, request.source);
  const sourceHash = await sha256File(resolve(cwd, request.source));
  let parameterManifest: StoredModelParameterManifest | undefined;
  if (parameterContract) {
    const outputPath = projectRelativePath(cwd, artifact);
    const modelId = `model-${canonicalDigest({ source: sourcePath, output: outputPath }).slice(0, 20)}`;
    const manifest: ModelParameterManifestV1 = {
      schema: 1,
      modelId,
      source: { path: sourcePath, sha256: sourceHash, entrypoint: "build" },
      output: { path: outputPath, sha256: artifactHash },
      parameters: parameterContract.parameters,
    };
    const manifestPath = `${resolve(cwd, artifact)}.parameters.json`;
    await writeJsonAtomic(manifestPath, manifest);
    parameterManifest = {
      path: projectRelativePath(cwd, manifestPath),
      sha256: await sha256File(manifestPath),
      manifest,
    };
  }
  await new HarnessRunStoreV7(cwd, activeBeforeBuild.state.runId).mutate(mechanicalRegistries, (loaded) => {
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
      event: { type: "ModelBuildObserved", data: { artifact: projectRelativePath(cwd, artifact), images: Object.values(contextRefs), evidence: [...envelopes.keys()] } },
    };
  });
  const inlineImages = await Promise.all(views.map(async (view) => ({
    name: view.name,
    data: (await readFile(view.path)).toString("base64"),
    mimeType: "image/png",
  })));
  return { build, visual, geometry, images: inlineImages, ...(parameterManifest ? { parameterManifest } : {}) };
}

export async function handleAgentApi(cwd: string, request: AgentApiRequest, authority: OperationAuthority = "author") {
  bootstrapAgentApiContracts();
  if (!request || request.schema !== 1 || typeof request.op !== "string") throw new Error("invalid Agent API request");
  const guardedOperation = AGENT_API_MUTATION_OPERATIONS[request.op as keyof typeof AGENT_API_MUTATION_OPERATIONS];
  if (guardedOperation) await requireCurrentAuthorization(cwd, guardedOperation, authority);
  switch (request.op) {
    case "workflow-list": {
      const packages = await discoverWorkflowPackages(cwd, mechanicalRegistries);
      return jsonValue(packages.map(({ id, description, tags, version }) => ({ id, description, tags, version })));
    }
    case "workflow-current": return jsonValue(await current(cwd));
    case "workflow-start": {
      const selected = await resolveWorkflowPackage(cwd, request.id, mechanicalRegistries);
      await cadStartSnapshot({
        cwd, registries: mechanicalRegistries, workflow: selected.workflow,
        interactionMode: request.interactionMode ?? "interactive",
      });
      return jsonValue(await current(cwd));
    }
    case "workflow-advance": {
      if (!request.event?.trim()) throw new Error("workflow event is required");
      const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
      if (!active) throw new Error("no active Pi-CAD v7 run");
      const store = new HarnessRunStoreV7(cwd, active.state.runId);
      const next = await store.mutate(mechanicalRegistries, (loaded) => ({ state: transitionRun(loaded.state, loaded.workflow, request.event), event: { type: "WorkflowAdvancedByAgentApi", data: { event: request.event } } }));
      return jsonValue({ phase: next.state.phase, status: next.state.status });
    }
    case "commit": {
      return jsonValue(await commitWorkspace({ cwd, registries: mechanicalRegistries, name: request.name, ...(request.parent === undefined ? {} : { parent: request.parent }), variables: request.variables, artifacts: request.artifacts, session: request.session }));
    }
    case "load": return jsonValue(await loadWorkspaceCommit(cwd, mechanicalRegistries, request.id));
    case "history": return jsonValue(await workspaceHistory(cwd, mechanicalRegistries));
    case "viewer-catalog": return viewerCatalog(cwd);
    case "probe": {
      const preset = request.preset?.trim() || "python";
      const rendered = await executeCadProbe(cwd, {
        preset,
        subject: request.subject ?? "current",
        purpose: request.purpose,
        code: request.code,
        args: request.args,
      });
      const details = "details" in rendered ? rendered.details as any : undefined;
      const value = preset === "python" ? details?.envelope?.payload?.result : details?.envelope?.payload;
      if (details?.presetFailed || value === undefined) throw new Error(rendered.content.map((item) => item.type === "text" ? item.text : "").join("\n") || `probe preset ${preset} failed`);
      const visuals = Array.isArray(details?.observation?.visuals) ? details.observation.visuals : [];
      const images = rendered.content.filter((item) => item.type === "image").map((item, index) => ({
        name: visuals[index]?.name ?? `view-${index + 1}`,
        data: item.data,
        mimeType: item.mimeType,
      }));
      return jsonValue({
        preset,
        value,
        ...(images.length ? { images } : {}),
        artifactHash: details.artifactHash ?? details.envelope?.inputHashes?.artifact,
        scriptHash: details.envelope?.inputHashes?.script,
        observationId: details.observationId,
      });
    }
    case "model-build": {
      return jsonValue(await buildAndObserve(cwd, request));
    }
    case "simulation-run": {
      const executed = await executeMechanicalRecipeV7({ cwd, kind: "simulation", recipe: request.recipe, action: request.action, obligationRef: request.obligationRef, outputs: request.outputs });
      return jsonValue({
        runId: executed.record.runId, recipeId: executed.record.recipeId, status: executed.record.status,
        computeIdentity: executed.record.computeIdentity, observation: executed.observation,
      });
    }
    case "review-current": {
      const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
      if (!active) return null;
      return jsonValue({ expectedProfile: active.workflow.phases[active.state.phase]?.reviewProfile ?? null, latest: active.state.latestReview ?? null });
    }
    default: throw new Error(`unsupported Agent API operation: ${(request as { op: string }).op}`);
  }
}
