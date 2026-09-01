import type { ViewerCatalog, ViewerSource } from "@shared/contracts";

const STEP = /\.(?:step|stp)$/i;

function artifactSources(
  artifacts: ViewerCatalog["projectHead"]["artifacts"],
  scope: "current" | "head" | "commit",
  commitId?: string,
): ViewerSource[] {
  return artifacts.filter((artifact) => STEP.test(artifact.path)).map((artifact) => ({
    kind: "cad",
    id: `${scope}:${commitId ?? "latest"}:${artifact.id}:${artifact.sha256}`,
    label: artifact.role.replaceAll("-", " "),
    path: artifact.path,
    role: artifact.role,
    sha256: artifact.sha256,
    scope,
    ...(commitId ? { commitId } : {}),
  }));
}

export function sourcesFromCatalog(catalog: ViewerCatalog, fallbackPath?: string): ViewerSource[] {
  const sources: ViewerSource[] = [
    ...artifactSources(catalog.currentRun?.artifacts ?? [], "current"),
    ...artifactSources(catalog.projectHead.artifacts, "head"),
    ...catalog.commits.flatMap((commit) => artifactSources(commit.artifacts, "commit", commit.id).map((source) => ({ ...source, label: `${commit.name} · ${source.label}` }))),
    ...catalog.simulationRuns.flatMap((run) => run.outputs.flatMap((output): ViewerSource[] => output.path && output.type !== "scalar" ? [{
      kind: "simulation",
      id: `simulation:${run.id}:${output.name}:${output.sha256 ?? output.path}`,
      label: `${run.recipeId} · ${output.name}`,
      path: output.path,
      outputType: output.type,
      runId: run.id,
      ...(output.unit ? { unit: output.unit } : {}),
      ...(output.sha256 ? { sha256: output.sha256 } : {}),
    }] : [])),
  ];
  if (fallbackPath && !sources.some((source) => source.path === fallbackPath)) {
    sources.unshift({ kind: "cad", id: `manual:${fallbackPath}`, label: fallbackPath.split(/[\\/]/).at(-1) || "Latest model", path: fallbackPath, role: "latest-build", scope: "manual" });
  }
  const seen = new Set<string>();
  return sources.filter((source) => {
    const identity = `${source.kind}:${source.sha256 ?? source.path}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function preferredSource(sources: ViewerSource[]): ViewerSource | undefined {
  return sources.find((source) => source.kind === "cad" && source.scope === "current" && /authoritative/i.test(source.role))
    ?? sources.find((source) => source.kind === "cad" && source.scope === "head" && /authoritative|design/i.test(source.role))
    ?? sources.find((source) => source.kind === "cad")
    ?? sources[0];
}
