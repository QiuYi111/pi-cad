import { resolve } from "node:path";

import type { AgentApiRequest } from "../authority/protocol.ts";
import { resolveActiveRun } from "../harness/run-scope.ts";
import { artifactPathForKind, buildStep, envelopeArtifactHash } from "../shared/capability.ts";
import { sha256File } from "../shared/hash.ts";
import { normalizeModelParameterDefinitions } from "../shared/model-parameters.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { observeCandidate, projectRelativePath } from "./observe.ts";

export async function buildAndObserve(cwd: string, request: Extract<AgentApiRequest, { op: "model-build" }>) {
  const importingReference = request.importMode === "reference";
  const solidifying = request.importMode === "solidify";
  if ((importingReference || solidifying) && !/\.(step|stp)$/i.test(request.source)) throw new Error("STEP import requires a STEP file");
  if ((importingReference || solidifying) && request.parameters) throw new Error("STEP import does not accept model parameters");
  const activeBeforeBuild = await resolveActiveRun(cwd, mechanicalRegistries);
  if (!activeBeforeBuild) throw new Error("model.build authorization lost its active workflow");
  const parameterContract = request.parameters
    ? normalizeModelParameterDefinitions(request.parameters)
    : undefined;
  const build = await buildStep(cwd, {
    source: request.source,
    output: request.output,
    force: request.force,
    parameters: parameterContract?.values,
    solidify: solidifying,
  });
  if (!build.ok) return { build, visual: null, images: [] };

  const artifact = artifactPathForKind(build, "step") ?? request.output;
  const artifactHash = envelopeArtifactHash(build, "step");
  if (!artifactHash) throw new Error("Pi-CAD model build lacks an authoritative STEP hash");
  const observed = await observeCandidate(cwd, activeBeforeBuild, {
    artifact,
    sourcePath: projectRelativePath(cwd, request.source),
    sourceHash: await sha256File(resolve(cwd, request.source)),
    artifactHash,
    validation: request.validation ?? "auto",
    ...(request.importMode ? { importMode: request.importMode } : {}),
    ...(parameterContract ? { parameters: parameterContract } : {}),
    backend: "build123d",
  });
  return { build, ...observed };
}
