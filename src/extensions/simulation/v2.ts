import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import type { CadRunState, EvidenceRef } from "../../shared/protocol.ts";
import { CadProjectStore, makeEvidenceId, nowIso, sha256File } from "../../shared/store.ts";
import { renderSimulationObservation } from "../../modules/simulate-v2/observation.ts";
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
    return [{ type: "text", text: [`Simulation ${run.runId} produced a partial failure observation ${snapshot.observationId}.`, `validForCommit=false`, ...diagnostics].join("\n").slice(0, 8192) }];
  }
  return renderSimulationObservation({
    runId: run.runId,
    observationId: snapshot.observationId,
    backend: run.backend,
    runtime: run.runtime,
    durationMs: (run.entrypoint?.durationMs ?? 0) + snapshot.observeResult.durationMs,
    observation: validated,
    diagnostics: [...(run.entrypoint?.diagnostics ?? []), ...snapshot.observeResult.diagnostics],
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
  if (recipe.observationProgramHash !== snapshot.observationProgramHash) throw new Error("observation program changed after observation");
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
    ...snapshot.exports.filter((item) => item.path && item.sha256).map((item) => ({ path: rel(cwd, resolve(observationDirectory, item.path!)), sha256: item.sha256! })),
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

export default function cadSimulationV2Extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cad_simulate",
    label: "CAD Simulate Recipe",
    description: "Run an agent-authored solver-native Recipe in a managed backend/runtime and return a controlled multimodal Observation. The Recipe owns physics, configuration, meshing, execution, and project-specific postprocessing. Pi-CAD freezes the Recipe and every explicitly declared input, runs without implicit project access, validates generic exports, returns images before bounded quantitative context and diagnostics, and retains raw artifacts/logs. This creates an immutable SimulationRun and ObservationSnapshot but never Evidence; use cad_commit_simulation after inspection.",
    promptSnippet: "Execute a Recipe-native simulation and observe its declared exports",
    promptGuidelines: ["Author or revise solver-native Recipes only under simulation/**; never encode physics in tool arguments.", "Declare every external project input in pi-sim.toml and choose a backend/runtime advertised in context.", "Inspect the images-first Observation and quantitative health. A successful solve is not Evidence until cad_commit_simulation."],
    parameters: Type.Object({ backend: Type.String({ minLength: 1 }), runtime: Type.String({ minLength: 1 }), recipe: Type.String({ minLength: 1 }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await createSimulationRun({ cwd: ctx.cwd, backend: params.backend, runtime: params.runtime, recipePath: params.recipe, outputs: params.outputs, runner: managedSimulationRunner });
      const store = new CadProjectStore(ctx.cwd);
      await store.appendEvent("SimulationRunCreated", { runId: result.run.runId, computeIdentity: result.run.computeIdentity, status: result.run.status });
      if (result.observation) await store.appendEvent("ObservationSnapshotCreated", { runId: result.run.runId, observationId: result.observation.observationId, validForCommit: result.observation.validForCommit });
      const content = result.observation ? await observationContent(result.run, result.observation, result.validatedObservation) : [{ type: "text", text: `Simulation ${result.run.runId} failed before an observation was materialized.` }];
      return { content, details: { simulationRunId: result.run.runId, observationId: result.observation?.observationId, computeIdentity: result.run.computeIdentity, validForCommit: result.observation?.validForCommit ?? false } };
    },
  });

  pi.registerTool({
    name: "cad_sim_observe",
    label: "CAD Re-observe Simulation",
    description: "Run only the observation program over one frozen SimulationRun and create a new immutable ObservationSnapshot without rerunning compute. Only the originally declared observation_files plus observe/export declarations may change; solver, mesh, entrypoint, inputs, runtime, and frozen raw state must still match.",
    promptSnippet: "Re-run a simulation Recipe's observation program",
    promptGuidelines: ["Use this after editing only declared observation_files.", "Changing solver, mesh, entrypoint, or inputs requires cad_simulate."],
    parameters: Type.Object({ run: Type.String({ minLength: 1 }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const { workflowRunId, store } = await currentWorkflow(ctx.cwd);
      const result = await createObservationSnapshot({ cwd: ctx.cwd, workflowRunId, runId: params.run, outputs: params.outputs, runner: managedSimulationRunner });
      await store.appendEvent("ObservationSnapshotCreated", { runId: result.run.runId, observationId: result.observation!.observationId, validForCommit: result.observation!.validForCommit });
      return { content: await observationContent(result.run, result.observation!, result.validatedObservation), details: { simulationRunId: result.run.runId, observationId: result.observation!.observationId, computeIdentity: result.run.computeIdentity, validForCommit: result.observation!.validForCommit } };
    },
  });

  pi.registerTool({
    name: "cad_commit_simulation",
    label: "Commit Simulation Evidence",
    description: "Promote one successfully completed managed SimulationRun and one exact valid ObservationSnapshot into version-bound Evidence for an existing case whose declared tool is cad_simulate. Pi-CAD re-verifies the frozen raw state, Recipe, runtime identity, all declared inputs, observation artifacts/program, and authoritative design or verified derivation. This performs no solve or postprocessing and does not judge engineering PASS.",
    promptSnippet: "Commit a validated simulation Observation as case-scoped Evidence",
    promptGuidelines: ["Commit only after inspecting the Observation.", "Evidence records provenance; it does not imply an engineering PASS."],
    parameters: Type.Object({ run: Type.String({ minLength: 1 }), observation: Type.Optional(Type.String({ minLength: 1 })), caseId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const evidence = await commitSimulation(ctx.cwd, params.run, params.observation, params.caseId);
      return { content: [{ type: "text", text: `Committed simulation Evidence ${evidence.id} for case ${params.caseId}. Evidence provenance is bound to ${evidence.simulationRunId}/${evidence.observationId}; existence does not imply engineering PASS.` }], details: { evidenceId: evidence.id, simulationRunId: evidence.simulationRunId, observationId: evidence.observationId, computeIdentity: evidence.computeIdentity } };
    },
  });
}
