import { canonicalDigest, jsonValue, type JsonValue } from "../harness/canonical.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { commitWorkspace, loadWorkspaceCommit, workspaceHistory } from "../harness/commit.ts";
import { commitEvidenceRef, transitionRun, unmetPhaseObligations } from "../harness/reducer.ts";
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
  const phase = loaded.workflow.phases[loaded.state.phase]!;
  return {
    runId: loaded.state.runId, workflowId: loaded.workflow.id, workflowHash: loaded.workflow.hash,
    phase: loaded.state.phase, purpose: phase.purpose, guidance: phase.guidance ?? null,
    status: loaded.state.status, unmet: unmetPhaseObligations(loaded.state, loaded.workflow),
    transitions: Object.entries(phase.transitions).map(([event, transition]) => ({ event, target: transition.target })),
    recommendedTemplates: phase.recommendedTemplates ?? [], recommendedSkills: phase.recommendedSkills ?? [],
  };
}

function projectRelativePath(cwd: string, path: string): string {
  const value = relative(resolve(cwd), resolve(cwd, path));
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`managed CAD output escaped the project root: ${path}`);
  }
  return value.replaceAll("\\", "/");
}

async function buildAndObserve(cwd: string, request: Extract<AgentApiRequest, { op: "model-build" }>) {
  const activeBeforeBuild = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!activeBeforeBuild) throw new Error("model.build authorization lost its active workflow");
  const build = await buildStep(cwd, { source: request.source, output: request.output, force: request.force });
  if (!build.ok) return { build, visual: null, images: [] };

  const artifact = artifactPathForKind(build, "step") ?? request.output;
  const visual = await inspectVisual(cwd, artifact, runVisualEvidenceDir(cwd, activeBeforeBuild.state.runId, artifact));
  if (!visual.ok) {
    const payload = visual.payload as { error?: string } | undefined;
    throw new Error(payload?.error || "Pi-CAD built the model but mandatory visual inspection failed");
  }
  const views = visualPayload(visual).views ?? [];
  if (!views.length) throw new Error("Pi-CAD built the model but mandatory visual inspection produced no images");
  const images = views.map((view) => view.path);
  const geometry = await inspectGeometry(cwd, artifact, runGeometryEvidencePath(cwd, activeBeforeBuild.state.runId, artifact));
  if (!geometry.ok) {
    const payload = geometry.payload as { error?: string } | undefined;
    throw new Error(payload?.error || "Pi-CAD built the model but mandatory geometry inspection failed");
  }

  // Keep the eager Prime attachment below as the immediate observation. When
  // a workflow is active, also carry the principal views into later Phase
  // Cards so mandatory visual context cannot silently disappear.
  const byName = new Map(views.map((view) => [view.name, view.path]));
  const selected = [byName.get("iso") ?? images[0], byName.get("front") ?? images[1]].filter((path): path is string => Boolean(path));
  const contextRefs = Object.fromEntries(selected.map((path, index) => [index === 0 ? "mandatoryImageIso" : "mandatoryImageFront", projectRelativePath(cwd, path)]));
  const artifactHash = envelopeArtifactHash(build, "step");
  if (!artifactHash) throw new Error("Pi-CAD model build lacks an authoritative STEP hash");
  await new HarnessRunStoreV7(cwd, activeBeforeBuild.state.runId).mutate(mechanicalRegistries, (loaded) => {
    let state = {
      ...loaded.state,
      artifacts: {
        ...loaded.state.artifacts,
        "candidate:authoritative": { id: "candidate:authoritative", path: projectRelativePath(cwd, artifact), sha256: artifactHash, role: "authoritative-candidate-design" },
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
      state = commitEvidenceRef(state, loaded.workflow, loaded.registryContract, evidence);
      payloads[evidence.path] = jsonValue({ schema: 1, evidence, envelope });
    }
    return {
      state,
      payloads,
      event: { type: "ModelBuildObserved", data: { artifact: projectRelativePath(cwd, artifact), images: Object.values(contextRefs), evidence: [...envelopes.keys()] } },
    };
  });
  return { build, visual, geometry, images };
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
    case "probe": {
      const rendered = await executeCadProbe(cwd, { preset: "python", subject: request.subject, purpose: request.purpose, code: request.code });
      const details = "details" in rendered ? rendered.details as any : undefined;
      const result = details?.envelope?.payload?.result;
      if (details?.presetFailed || result === undefined) throw new Error(rendered.content.map((item) => item.type === "text" ? item.text : "").join("\n") || "programmable probe failed");
      return jsonValue({ value: result, artifactHash: details.artifactHash ?? details.envelope?.inputHashes?.artifact, scriptHash: details.envelope?.inputHashes?.script, observationId: details.observationId });
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
