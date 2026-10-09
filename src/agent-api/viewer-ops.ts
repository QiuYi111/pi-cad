import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { jsonValue, type JsonValue } from "../harness/canonical.ts";
import { workspaceHistory } from "../harness/commit.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { resolveActiveRun } from "../harness/run-scope.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { sha256File } from "../shared/hash.ts";
import type { ModelParameterManifestV1, StoredModelParameterManifest } from "../shared/model-parameters.ts";
import { projectRelativePath } from "./observe.ts";

export async function viewerCatalog(cwd: string) {
  const project = new HarnessProjectStoreV7(cwd);
  const [{ state: projectState }, active] = await Promise.all([
    project.load(),
    resolveActiveRun(cwd, mechanicalRegistries),
  ]);
  // Commit history lives in the run that recorded it, so it follows the
  // caller's conversation like the run does. Project HEAD stays visible to
  // every conversation because it is the shared project artifact.
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
    ...commits.flatMap((commit) => commit.artifacts),
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
  if (active) {
    const runStore = new HarnessRunStoreV7(cwd, active.state.runId);
    for (const commit of commits) for (const artifact of commit.artifacts.filter((item) => item.role === "model-parameter-manifest" || /\.parameters\.json$/i.test(item.path))) {
      const snapshot = commit.artifactSnapshots?.[artifact.sha256];
      if (!snapshot) continue;
      try {
        const manifest = await runStore.transactions.readJson<ModelParameterManifestV1>(snapshot.path);
        if (manifest?.schema === 1 && Array.isArray(manifest.parameters)) parameterManifests.push({ path: `@commit/${commit.id}/${artifact.path}`, sha256: artifact.sha256, manifest });
      } catch { /* Corrupt historical metadata is omitted instead of gaining authority. */ }
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
