import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMechanicalActionTool } from "../../domains/mechanical/register-action.ts";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import type { CadRunState, EvidenceRef } from "../../shared/protocol.ts";
import { CadProjectStore, makeEvidenceId, nowIso, sha256File } from "../../shared/store.ts";
import { renderSimulationObservation } from "../../modules/simulate-v2/observation.ts";
import { recordObservation } from "../../core/observation-index.ts";
import { renderSimulationFailure, recordSimulationFailure, simulationFailure, type SimulationFailure } from "../../modules/simulate-v2/failure.ts";
import { preflightSimulation, SimulationPreflightError } from "../../modules/simulate-v2/preflight.ts";
import { loadSimulationRecipe } from "../../modules/simulate-v2/protocol.ts";
import { managedSimulationRunner } from "../../modules/simulate-v2/runtime.ts";
import {
  createObservationSnapshot,
  createSimulationRun,
  readObservationSnapshot,
  readSimulationRun,
  verifyRawProject,
  verifySnapshotFiles,
  type ObservationSnapshotRecord,
  type SimulationRunRecord,
} from "../../modules/simulate-v2/store.ts";
import { selectKernelEngine } from "../../harness/engine-router.ts";
import { cadSimulateV7, commitMechanicalRecipeByRefV7, observeMechanicalRecipeV7 } from "../../domains/mechanical/recipe-actions-v7.ts";

function rel(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(path)).split(sep).join("/");
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

async function currentWorkflow(cwd: string): Promise<{ store: CadProjectStore; state: CadRunState; workflowRunId: string }> {
  const store = new CadProjectStore(cwd);
  const workflowRunId = await store.currentRunId();
  const state = await store.load();
  if (!workflowRunId || !state || state.runId !== workflowRunId) throw new Error("simulation requires an active Pi-CAD workflow");
  return { store, state, workflowRunId };
}

async function observationContent(run: SimulationRunRecord, snapshot: ObservationSnapshotRecord, validated: Awaited<ReturnType<typeof createSimulationRun>>["validatedObservation"]): Promise<any[]> {
  if (!validated) {
    const diagnostics = [...(run.entrypoint?.diagnostics ?? []), ...(snapshot.observeResult.diagnostics ?? [])].slice(0, 40);
    const accelerator = run.runtimeIdentity.accelerator;
    return [{ type: "text", text: [
      `Simulation ${run.runId} produced a partial failure observation ${snapshot.observationId}.`,
      "validForCommit=false",
      `runtime=${run.runtime} resolvedVersion=${run.runtimeIdentity.resolvedVersion}`,
      ...(accelerator?.requestedDevice !== undefined ? [`requestedDevice=${String(accelerator.requestedDevice)}`] : []),
      ...(accelerator?.actualDevice !== undefined ? [`actualDevice=${String(accelerator.actualDevice)}`] : []),
      ...diagnostics,
    ].join("\n").slice(0, 8192) }];
  }
  return renderSimulationObservation({
    runId: run.runId,
    observationId: snapshot.observationId,
    backend: run.backend,
    runtime: run.runtime,
    runtimeIdentity: run.runtimeIdentity,
    durationMs: (run.entrypoint?.durationMs ?? 0) + snapshot.observeResult.durationMs,
    observation: validated,
    diagnostics: [...(run.entrypoint?.diagnostics ?? []), ...snapshot.observeResult.diagnostics],
  });
}

function failureForRun(run: SimulationRunRecord, observation?: ObservationSnapshotRecord): SimulationFailure | undefined {
  if (run.status === "interrupted") return simulationFailure({ stage: "interrupted", code: "run_interrupted", retryable: false, likelyOwner: "harness", suggestedAction: "Create a new simulation run; interrupted runs are never committable.", message: `Simulation ${run.runId} was interrupted.`, runId: run.runId });
  if (run.entrypoint?.exitCode !== 0) {
    const quota = run.entrypoint?.exitCode === 122 || run.entrypoint?.diagnostics.some((line) => /quota/i.test(line));
    return simulationFailure({
      stage: quota ? "quota" : "compute",
      code: quota ? "workspace_quota_exceeded" : `entrypoint_exit_${run.entrypoint?.exitCode ?? "unknown"}`,
      retryable: true,
      likelyOwner: quota ? "recipe" : "recipe",
      suggestedAction: quota ? "Reduce generated workspace data or request a deliberately larger managed limit." : "Read the indexed stdout/stderr collections, repair the Recipe, and retry only after a relevant change.",
      message: run.entrypoint?.diagnostics.join("\n") || `Simulation entrypoint failed for ${run.runId}.`,
      runId: run.runId,
      observationId: observation?.observationId,
      logCollections: ["entrypoint.stdout", "entrypoint.stderr"],
    });
  }
  if (observation && !observation.validForCommit) return simulationFailure({ stage: observation.observeResult.exitCode === 0 ? "validate" : "observe", code: observation.observeResult.exitCode === 0 ? "observation_invalid" : `observer_exit_${observation.observeResult.exitCode}`, retryable: true, likelyOwner: "recipe", suggestedAction: "Read observer stdout/stderr and validation diagnostics, then edit only declared observation_files or export declarations and call cad_sim_observe.", message: observation.warnings.join("\n") || observation.observeResult.diagnostics.join("\n") || "Observer output is not valid for commit.", runId: run.runId, observationId: observation.observationId, logCollections: ["observer.stdout", "observer.stderr"] });
  return undefined;
}

async function indexSimulationObservation(cwd: string, state: CadRunState, result: Awaited<ReturnType<typeof createSimulationRun>>) {
  const readLog = (path: string) => readFile(path, "utf-8").catch(() => "");
  const [computeStdout, computeStderr, observeStdout, observeStderr] = await Promise.all([
    readLog(join(result.runDirectory, "logs", "stdout.log")),
    readLog(join(result.runDirectory, "logs", "stderr.log")),
    result.observationDirectory ? readLog(join(result.observationDirectory, "logs", "stdout.log")) : Promise.resolve(""),
    result.observationDirectory ? readLog(join(result.observationDirectory, "logs", "stderr.log")) : Promise.resolve(""),
  ]);
  const visuals = (result.observation?.exports ?? []).flatMap((item) => {
    const paths = [] as Array<{ name: string; path: string }>;
    if (item.type === "image" && item.path && result.observationDirectory) paths.push({ name: item.name, path: resolve(result.observationDirectory, item.path) });
    if (item.plotPath && result.observationDirectory) paths.push({ name: `${item.name}_plot`, path: resolve(result.observationDirectory, item.plotPath) });
    return paths;
  });
  return recordObservation({
    cwd,
    runId: state.runId,
    phase: state.phase,
    tool: "cad_simulate",
    preset: "simulation",
    artifactHash: state.route?.objective === "analyze" ? state.baselineArtifactHash : state.currentArtifactHash,
    bundle: {
      ok: result.run.status === "completed" && Boolean(result.observation?.validForCommit),
      tool: "cad_simulate",
      headline: `Simulation ${result.run.runId} ${result.run.status}; observation=${result.observation?.observationId ?? "none"}`,
      facts: [
        { key: "backend/runtime", value: `${result.run.backend}/${result.run.runtime}` },
        { key: "computeIdentity", value: result.run.computeIdentity },
        { key: "validForCommit", value: String(result.observation?.validForCommit ?? false) },
      ],
      visuals,
      diagnostics: [...(result.run.entrypoint?.diagnostics ?? []), ...(result.observation?.observeResult.diagnostics ?? [])].map((message) => ({ level: "error" as const, message })),
      provenance: { tool: "cad_simulate", toolVersion: "v2", backendVersion: result.run.runtimeIdentity.resolvedVersion, durationMs: (result.run.entrypoint?.durationMs ?? 0) + (result.observation?.observeResult.durationMs ?? 0), inputHashes: Object.fromEntries(result.run.inputs.map((item) => [item.projectPath, item.sha256])), outputHashes: Object.fromEntries((result.observation?.exports ?? []).flatMap((item) => item.path && item.sha256 ? [[item.path, item.sha256]] : [])) },
      artifacts: [],
    },
    resolvedSubjects: result.run.inputs.map((item) => ({ source: "declaredInput", path: item.projectPath, sha256: item.sha256 })),
    rawPayload: { entrypoint: { stdout: computeStdout, stderr: computeStderr }, observer: { stdout: observeStdout, stderr: observeStderr }, exports: result.observation?.exports ?? [] },
  });
}

async function assertCurrentInputs(cwd: string, runDirectory: string, run: SimulationRunRecord, state: CadRunState): Promise<{ path: string; sha256: string; derivation?: { recordPath: string; outputPath: string; outputHash: string } }> {
  const artifactPath = state.route?.objective === "analyze" ? state.baselineArtifactPath : state.currentArtifactPath;
  const artifactHash = state.route?.objective === "analyze" ? state.baselineArtifactHash : state.currentArtifactHash;
  if (!artifactPath || !artifactHash) throw new Error("current authoritative artifact is not bound");
  const current = resolve(cwd, artifactPath);
  if (!existsSync(current) || await sha256File(current) !== artifactHash) throw new Error("current authoritative artifact hash changed");
  const declared = run.inputs.some((item) => {
    const root = resolve(cwd, item.projectPath);
    return item.kind === "file" ? resolve(root) === current : inside(root, current);
  });
  if (declared) {
    const frozen = resolve(runDirectory, "raw-project", artifactPath);
    if (!existsSync(frozen) || await sha256File(frozen) !== artifactHash) throw new Error("frozen simulation input does not match the current authoritative artifact");
    return { path: artifactPath, sha256: artifactHash };
  }

  // A Recipe may solve a harness-recorded analysis derivation without
  // exposing a second current/baseline ABI. Both the derivation record and
  // its exact output must be explicit declared inputs.
  for (const recordInput of run.inputs.filter((item) => item.kind === "file")) {
    const recordPath = resolve(runDirectory, "raw-project", recordInput.projectPath);
    let record: { sourceHash?: string; outputHash?: string };
    try {
      record = JSON.parse(await readFile(recordPath, "utf-8")) as { sourceHash?: string; outputHash?: string };
    } catch {
      continue;
    }
    if (record.sourceHash !== artifactHash || !record.outputHash) continue;
    for (const outputInput of run.inputs.filter((item) => item.kind === "file" && item !== recordInput)) {
      const outputPath = resolve(runDirectory, "raw-project", outputInput.projectPath);
      if (existsSync(outputPath) && await sha256File(outputPath) === record.outputHash) {
        return {
          path: artifactPath,
          sha256: artifactHash,
          derivation: { recordPath: recordInput.projectPath, outputPath: outputInput.projectPath, outputHash: record.outputHash },
        };
      }
    }
  }
  throw new Error(`authoritative artifact or a verified derivation is absent from frozen declared inputs: ${artifactPath}`);
}

export async function commitSimulation(cwd: string, runId: string, observationId: string | undefined, caseId: string, runtimeRunner = managedSimulationRunner): Promise<EvidenceRef> {
  const { store, state, workflowRunId } = await currentWorkflow(cwd);
  const loaded = await readSimulationRun(cwd, workflowRunId, runId);
  const run = loaded.record;
  if (run.status !== "completed" || !run.entrypoint || run.entrypoint.exitCode !== 0) throw new Error(`simulation run ${runId} is not successfully completed`);
  const selectedObservation = observationId ?? run.latestObservationId;
  if (!selectedObservation) throw new Error(`simulation run ${runId} has no observation`);
  const snapshot = await readObservationSnapshot(loaded.directory, selectedObservation);
  if (!snapshot.validForCommit || snapshot.observeResult.exitCode !== 0) throw new Error(`observation ${selectedObservation} is not valid for commit`);
  await verifySnapshotFiles(loaded.directory, snapshot);
  await verifyRawProject(loaded.directory, run);

  const recipe = await loadSimulationRecipe(cwd, run.sourceRecipePath);
  if (recipe.computeRecipeHash !== run.computeRecipeHash) throw new Error("compute Recipe changed after simulation");
  const currentInputHashes = new Map(recipe.inputs.map((item) => [item.projectPath, item.sha256]));
  for (const input of run.inputs) if (currentInputHashes.get(input.projectPath) !== input.sha256) throw new Error(`declared input changed after simulation: ${input.projectPath}`);
  const currentRuntime = await runtimeRunner.resolveRuntime(cwd, run.backend, run.runtime);
  if (currentRuntime.digest !== run.runtimeIdentity.digest) throw new Error("immutable runtime identity changed after simulation");

  const obligation = state.evidenceObligations?.simulation?.cases?.find((item) => item.id === caseId && item.tool === "cad_simulate");
  if (!obligation) throw new Error(`caseId is not a current cad_simulate obligation: ${caseId}`);
  const subject = await assertCurrentInputs(cwd, loaded.directory, run, state);
  const observationDirectory = join(loaded.directory, "observations", selectedObservation);
  const provenancePath = join(observationDirectory, "provenance-manifest.json");
  const provenance = {
    schema: 1,
    simulationRunId: runId,
    observationId: selectedObservation,
    caseId,
    computeIdentity: run.computeIdentity,
    rawProjectHash: run.rawProjectHash,
    computeRecipeHash: run.computeRecipeHash,
    observationProgramHash: snapshot.observationProgramHash,
    observationProgramPath: snapshot.observationProgramPath,
    observationProgramSnapshotHash: snapshot.observationProgramSnapshotHash,
    observationProgramFiles: snapshot.observationProgramFiles,
    backend: run.backend,
    runtime: run.runtime,
    runtimeIdentity: run.runtimeIdentity,
    inputs: run.inputs,
    exports: snapshot.exports,
    subject,
  };
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf-8");
  const provenanceHash = await sha256File(provenancePath);
  const artifacts = [
    ...snapshot.observationProgramFiles.map((item) => ({ path: rel(cwd, resolve(observationDirectory, item.path)), sha256: item.sha256 })),
    ...snapshot.exports.flatMap((item) => [
      ...(item.path && item.sha256 ? [{ path: rel(cwd, resolve(observationDirectory, item.path)), sha256: item.sha256 }] : []),
      ...(item.plotPath && item.plotSha256 ? [{ path: rel(cwd, resolve(observationDirectory, item.plotPath)), sha256: item.plotSha256 }] : []),
    ]),
    { path: rel(cwd, provenancePath), sha256: provenanceHash },
  ];
  const evidence: EvidenceRef = {
    id: makeEvidenceId("simulation", subject.sha256, run.computeIdentity, caseId),
    kind: "simulation",
    tool: "cad_simulate",
    artifactHash: subject.sha256,
    subjectArtifactHash: subject.sha256,
    sourceHash: state.currentSourceHash,
    specHash: run.computeIdentity,
    caseId,
    paths: artifacts.map((item) => item.path),
    artifacts,
    inputArtifacts: [
      { path: subject.path, sha256: subject.sha256, role: "authoritativeArtifact", hashKind: "sha256-file" as const },
      ...run.inputs.map((input) => ({ path: input.projectPath, sha256: input.sha256, role: "declaredInput", hashKind: "simulation-tree-v1" as const })),
    ],
    simulationRunId: runId,
    observationId: selectedObservation,
    computeIdentity: run.computeIdentity,
    provenanceManifestPath: rel(cwd, provenancePath),
    provenanceManifestHash: provenanceHash,
    createdAt: nowIso(),
  };
  const replaced = state.evidence.filter((item) => item.kind === "simulation" && item.tool === "cad_simulate" && item.caseId === caseId && item.artifactHash === subject.sha256);
  const next: CadRunState = {
    ...state,
    evidence: [...state.evidence.filter((item) => !replaced.includes(item)), evidence],
    staleEvidence: [...state.staleEvidence, ...replaced.filter((item) => !state.staleEvidence.includes(item))],
    updatedAt: nowIso(),
  };
  await store.save(next);
  await store.appendEvent("SimulationEvidenceCommitted", { runId, observationId: selectedObservation, caseId, evidenceId: evidence.id, computeIdentity: run.computeIdentity });
  return evidence;
}

export const CadSimulateParametersSchema = Type.Union([
  Type.Object({ recipe: Type.String({ minLength: 1, description: "v7 directory containing pi-recipe.yaml" }), obligationRef: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false }),
  Type.Object({ backend: Type.String({ minLength: 1 }), runtime: Type.String({ minLength: 1 }), recipe: Type.String({ minLength: 1, description: "v6 directory containing pi-sim.toml" }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false }),
]);
export const CadSimObserveParametersSchema = Type.Object({ run: Type.String({ minLength: 1 }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false });
export const CadCommitSimulationParametersSchema = Type.Union([
  Type.Object({ run: Type.String({ minLength: 1 }), observation: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ run: Type.String({ minLength: 1 }), observation: Type.Optional(Type.String({ minLength: 1 })), caseId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

export default function cadSimulationV2Extension(pi: ExtensionAPI): void {
  registerMechanicalActionTool(pi, {
    name: "cad_simulate",
    label: "CAD Simulate Recipe",
    description: "Run an agent-authored solver-native Recipe in a managed backend/runtime and return a controlled multimodal Observation. The Recipe owns physics, configuration, meshing, execution, and project-specific postprocessing. Pi-CAD freezes the Recipe and every explicitly declared input, runs without implicit project access, validates generic exports, returns images before bounded quantitative context and diagnostics, and retains raw artifacts/logs. This creates an immutable SimulationRun and ObservationSnapshot but never Evidence; use cad_commit_simulation after inspection.",
    promptSnippet: "Execute a Recipe-native simulation and observe its declared exports",
    promptGuidelines: ["Author or revise solver-native Recipes only under simulation/**; never encode physics in tool arguments.", "Declare every external project input in pi-sim.toml and choose a backend/runtime advertised in context.", "Inspect the images-first Observation and quantitative health. A successful solve is not Evidence until cad_commit_simulation."],
    parameters: CadSimulateParametersSchema,
    async execute(_id, params, _signal, _update, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        if (!("obligationRef" in params)) return { content: [{ type: "text", text: "cad_simulate v7 requires recipe and obligationRef; backend/runtime come from pi-recipe.yaml" }] };
        try {
          const result = await cadSimulateV7({ cwd: ctx.cwd, recipe: params.recipe, obligationRef: params.obligationRef, ...(params.action ? { action: params.action } : {}), ...(params.outputs ? { outputs: params.outputs } : {}), signal: _signal });
          return { content: [{ type: "text", text: `Simulation Recipe ${result.record.runId} ${result.record.status}; obligation=${params.obligationRef}. Call cad_sim_observe with this run.` }], details: { simulationRunId: result.record.runId, computeIdentity: result.record.computeIdentity, validForCommit: false } };
        } catch (error) { return { content: [{ type: "text", text: `cad_simulate failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      if (!("backend" in params)) return { content: [{ type: "text", text: "cad_simulate v6 requires backend/runtime" }] };
      const { store, state, workflowRunId } = await currentWorkflow(ctx.cwd);
      let prepared;
      try {
        prepared = await preflightSimulation({ cwd: ctx.cwd, state, backend: params.backend, runtime: params.runtime, recipePath: params.recipe, outputs: params.outputs, runner: managedSimulationRunner });
      } catch (error) {
        const base = error instanceof SimulationPreflightError ? error.failure : simulationFailure({ stage: "manifest", code: "preflight_exception", retryable: true, likelyOwner: "harness", suggestedAction: "Inspect the structured failure and correct the owning layer before retrying.", message: error instanceof Error ? error.message : String(error) });
        const failure = await recordSimulationFailure(ctx.cwd, workflowRunId, base);
        return { content: [{ type: "text", text: renderSimulationFailure(failure) }], details: { failure, validForCommit: false } };
      }
      const result = await createSimulationRun({ cwd: ctx.cwd, backend: params.backend, runtime: params.runtime, recipePath: params.recipe, outputs: params.outputs, runner: managedSimulationRunner, prepared });
      await store.appendEvent("SimulationRunCreated", { runId: result.run.runId, computeIdentity: result.run.computeIdentity, status: result.run.status });
      if (result.observation) await store.appendEvent("ObservationSnapshotCreated", { runId: result.run.runId, observationId: result.observation.observationId, validForCommit: result.observation.validForCommit });
      let contextObservation: Awaited<ReturnType<typeof indexSimulationObservation>> | undefined;
      let storageFailure: SimulationFailure | undefined;
      try { contextObservation = await indexSimulationObservation(ctx.cwd, state, result); }
      catch (error) { storageFailure = simulationFailure({ stage: /quota/i.test(String(error)) ? "quota" : "validate", code: "observation_index_failed", retryable: true, likelyOwner: "harness", suggestedAction: "Free or deliberately raise run observation storage quota; the SimulationRun remains the underlying fact source.", message: error instanceof Error ? error.message : String(error), runId: result.run.runId, observationId: result.observation?.observationId }); }
      const runFailure = failureForRun(result.run, result.observation) ?? storageFailure;
      const failure = runFailure ? await recordSimulationFailure(ctx.cwd, workflowRunId, runFailure) : undefined;
      const content = result.observation ? await observationContent(result.run, result.observation, result.validatedObservation) : [{ type: "text", text: `Simulation ${result.run.runId} failed before an observation was materialized.` }];
      if (failure) content.push({ type: "text", text: `${renderSimulationFailure(failure)}${contextObservation ? `\ncontextObservationId=${contextObservation.observationId}` : ""}` });
      else content.push({ type: "text", text: `contextObservationId=${contextObservation!.observationId}; use cad_recall_observation to page complete logs/exports.` });
      return { content, details: { simulationRunId: result.run.runId, observationId: result.observation?.observationId, ...(contextObservation ? { contextObservationId: contextObservation.observationId } : {}), computeIdentity: result.run.computeIdentity, validForCommit: result.observation?.validForCommit ?? false, requestedDevice: result.run.runtimeIdentity.accelerator?.requestedDevice, actualDevice: result.run.runtimeIdentity.accelerator?.actualDevice, ...(failure ? { failure } : {}), observationStored: Boolean(contextObservation) } };
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_sim_observe",
    label: "CAD Re-observe Simulation",
    description: "Run only the observation program over one frozen SimulationRun and create a new immutable ObservationSnapshot without rerunning compute. Only the originally declared observation_files plus observe/export declarations may change; solver, mesh, entrypoint, inputs, runtime, and frozen raw state must still match.",
    promptSnippet: "Re-run a simulation Recipe's observation program",
    promptGuidelines: ["Use this after editing only declared observation_files.", "Changing solver, mesh, entrypoint, or inputs requires cad_simulate."],
    parameters: CadSimObserveParametersSchema,
    async execute(_id, params, _signal, _update, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        try {
          const observation = await observeMechanicalRecipeV7({ cwd: ctx.cwd, run: params.run, signal: _signal });
          return { content: [{ type: "text", text: `Observation ${observation.observationId} validForCommit=${observation.validForCommit}; exports=${observation.exports.map((item) => item.name).join(",")}` }], details: { simulationRunId: params.run, observationId: observation.observationId, validForCommit: observation.validForCommit } };
        } catch (error) { return { content: [{ type: "text", text: `cad_sim_observe failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      const { workflowRunId, store, state } = await currentWorkflow(ctx.cwd);
      let result;
      try {
        result = await createObservationSnapshot({ cwd: ctx.cwd, workflowRunId, runId: params.run, outputs: params.outputs, runner: managedSimulationRunner });
      } catch (error) {
        const base = simulationFailure({ stage: "observe", code: "reobserve_rejected", retryable: true, likelyOwner: "recipe", suggestedAction: /compute Recipe changed|declared simulation input changed|observation_files declaration changed/.test(String(error)) ? "A compute-affecting file changed; create a new cad_simulate run." : "Repair only declared observation_files/export declarations, then retry cad_sim_observe.", message: error instanceof Error ? error.message : String(error), runId: params.run });
        const failure = await recordSimulationFailure(ctx.cwd, workflowRunId, base);
        return { content: [{ type: "text", text: renderSimulationFailure(failure) }], details: { failure, validForCommit: false } };
      }
      await store.appendEvent("ObservationSnapshotCreated", { runId: result.run.runId, observationId: result.observation!.observationId, validForCommit: result.observation!.validForCommit });
      let contextObservation: Awaited<ReturnType<typeof indexSimulationObservation>> | undefined;
      let storageFailure: SimulationFailure | undefined;
      try { contextObservation = await indexSimulationObservation(ctx.cwd, state, result); }
      catch (error) { storageFailure = simulationFailure({ stage: /quota/i.test(String(error)) ? "quota" : "validate", code: "observation_index_failed", retryable: true, likelyOwner: "harness", suggestedAction: "Free or deliberately raise run observation storage quota; the SimulationRun remains the underlying fact source.", message: error instanceof Error ? error.message : String(error), runId: result.run.runId, observationId: result.observation?.observationId }); }
      const runFailure = failureForRun(result.run, result.observation) ?? storageFailure;
      const failure = runFailure ? await recordSimulationFailure(ctx.cwd, workflowRunId, runFailure) : undefined;
      const content = await observationContent(result.run, result.observation!, result.validatedObservation);
      content.push({ type: "text", text: failure ? `${renderSimulationFailure(failure)}${contextObservation ? `\ncontextObservationId=${contextObservation.observationId}` : ""}` : `contextObservationId=${contextObservation!.observationId}; use cad_recall_observation to page complete observer logs/exports.` });
      return { content, details: { simulationRunId: result.run.runId, observationId: result.observation!.observationId, ...(contextObservation ? { contextObservationId: contextObservation.observationId } : {}), computeIdentity: result.run.computeIdentity, validForCommit: result.observation!.validForCommit, requestedDevice: result.run.runtimeIdentity.accelerator?.requestedDevice, actualDevice: result.run.runtimeIdentity.accelerator?.actualDevice, ...(failure ? { failure } : {}), observationStored: Boolean(contextObservation) } };
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_commit_simulation",
    label: "Commit Simulation Evidence",
    description: "Promote one successfully completed managed SimulationRun and one exact valid ObservationSnapshot into version-bound Evidence for an existing case whose declared tool is cad_simulate. Pi-CAD re-verifies the frozen raw state, Recipe, runtime identity, all declared inputs, observation artifacts/program, and authoritative design or verified derivation. This performs no solve or postprocessing and does not judge engineering PASS.",
    promptSnippet: "Commit a validated simulation Observation as case-scoped Evidence",
    promptGuidelines: ["Commit only after inspecting the Observation.", "Evidence records provenance; it does not imply an engineering PASS."],
    parameters: CadCommitSimulationParametersSchema,
    async execute(_id, params, _signal, _update, ctx) {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        if (!params.observation || "caseId" in params) return { content: [{ type: "text", text: "cad_commit_simulation v7 accepts only {run, observation}; the obligation was pre-bound at execution" }] };
        try {
          const committed = await commitMechanicalRecipeByRefV7({ cwd: ctx.cwd, run: params.run, observation: params.observation });
          const evidence = committed.state.evidence.find((item) => item.computeIdentity);
          return { content: [{ type: "text", text: `Committed pre-bound Simulation Evidence ${evidence?.id ?? "(idempotent)"}.` }], details: { evidenceId: evidence?.id, simulationRunId: params.run, observationId: params.observation } };
        } catch (error) { return { content: [{ type: "text", text: `cad_commit_simulation failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
      }
      if (!("caseId" in params)) return { content: [{ type: "text", text: "cad_commit_simulation v6 requires caseId" }] };
      try {
        const evidence = await commitSimulation(ctx.cwd, params.run, params.observation, params.caseId);
        return { content: [{ type: "text", text: `Committed simulation Evidence ${evidence.id} for case ${params.caseId}. Evidence provenance is bound to ${evidence.simulationRunId}/${evidence.observationId}; existence does not imply engineering PASS.` }], details: { evidenceId: evidence.id, simulationRunId: evidence.simulationRunId, observationId: evidence.observationId, computeIdentity: evidence.computeIdentity } };
      } catch (error) {
        const { workflowRunId } = await currentWorkflow(ctx.cwd);
        const failure = await recordSimulationFailure(ctx.cwd, workflowRunId, simulationFailure({ stage: "validate", code: "commit_rejected", retryable: false, likelyOwner: "input", suggestedAction: "Use the exact current case obligation and an immutable valid run/observation; rerun if Recipe, runtime, inputs, or authoritative artifact changed.", message: error instanceof Error ? error.message : String(error), runId: params.run, observationId: params.observation }));
        return { content: [{ type: "text", text: renderSimulationFailure(failure) }], details: { failure, committed: false } };
      }
    },
  });
}
