import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { phaseContract } from "../../control/phase-contract.ts";
import { writePathAllowed } from "../../core/policies.ts";
import type { CadRunState } from "../../shared/protocol.ts";
import { loadSimulationRecipe, parseSimulationManifest, selectSimulationOutputs, type LoadedSimulationRecipe } from "./protocol.ts";
import type { SimulationCommandRunner } from "./store.ts";
import { simulationFailure, type SimulationFailure, type SimulationFailureOwner, type SimulationFailureStage } from "./failure.ts";

interface PreflightIssue {
  stage: SimulationFailureStage;
  code: string;
  message: string;
  likelyOwner: SimulationFailureOwner;
  suggestedAction: string;
}

export interface SimulationPreflightResult {
  recipe: LoadedSimulationRecipe;
  selectedOutputs: string[];
  runtimeIdentity: Awaited<ReturnType<SimulationCommandRunner["resolveRuntime"]>>;
}

export class SimulationPreflightError extends Error {
  constructor(readonly failure: SimulationFailure) {
    super(failure.message);
    this.name = "SimulationPreflightError";
  }
}

function inside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function issue(stage: SimulationFailureStage, code: string, message: string, likelyOwner: SimulationFailureOwner, suggestedAction: string): PreflightIssue {
  return { stage, code, message, likelyOwner, suggestedAction };
}

/** Discover Recipe, input, permission, observer and runtime problems before compute. */
export async function preflightSimulation(input: {
  cwd: string;
  state: CadRunState;
  backend: string;
  runtime: string;
  recipePath: string;
  outputs?: string[];
  runner: SimulationCommandRunner;
}): Promise<SimulationPreflightResult> {
  const issues: PreflightIssue[] = [];
  const projectRoot = resolve(input.cwd);
  const recipeRoot = resolve(projectRoot, input.recipePath);
  if (!inside(projectRoot, recipeRoot)) {
    issues.push(issue("manifest", "recipe_path_escape", "Recipe path escapes the project root", "recipe", "Move the Recipe directory under simulation/**."));
  }
  let pathIsDirectory = false;
  try {
    const info = await stat(recipeRoot);
    pathIsDirectory = info.isDirectory();
    if (!pathIsDirectory) {
      issues.push(issue("manifest", basename(recipeRoot) === "pi-sim.toml" ? "recipe_manifest_passed" : "recipe_not_directory", "cad_simulate.recipe must be the directory containing pi-sim.toml, not a file", "recipe", "Pass the Recipe directory, for example simulation/my-case."));
    }
  } catch {
    issues.push(issue("manifest", "recipe_missing", `Recipe directory does not exist: ${input.recipePath}`, "recipe", "Create or copy a complete Recipe under simulation/**."));
  }
  const grants = new Set(phaseContract(input.state.phase).grants);
  const permission = writePathAllowed(input.cwd, input.recipePath, input.state.mutationPolicy, grants.has("file_edit_recipe"));
  if (!permission.allowed) issues.push(issue("manifest", "recipe_write_forbidden", permission.reason ?? "current phase cannot author this Recipe", "recipe", "Stay in a simulation-capable review phase and write only simulation/**, or use revise for source-authored analysis inputs."));

  let parsed: ReturnType<typeof parseSimulationManifest> | undefined;
  if (pathIsDirectory) {
    try {
      parsed = parseSimulationManifest(await readFile(resolve(recipeRoot, "pi-sim.toml"), "utf-8"));
    } catch (error) {
      issues.push(issue("manifest", "manifest_invalid", error instanceof Error ? error.message : String(error), "recipe", "Repair every reported pi-sim.toml declaration before retrying."));
    }
  }
  if (parsed) {
    const inspectDeclaration = async (declaration: string, kind: "input" | "observation") => {
      const path = resolve(recipeRoot, declaration);
      if (!inside(kind === "input" ? projectRoot : recipeRoot, path)) {
        issues.push(issue(kind === "input" ? "inputs" : "manifest", `${kind}_path_escape`, `${kind} path escapes its allowed root: ${declaration}`, kind === "input" ? "input" : "recipe", `Move ${declaration} into the declared project/Recipe closure.`));
        return;
      }
      try { await access(path, constants.R_OK); }
      catch { issues.push(issue(kind === "input" ? "inputs" : "manifest", `${kind}_missing`, `${kind} path is missing or unreadable: ${declaration}`, kind === "input" ? "input" : "recipe", `Create, import, or correct ${declaration}.`)); }
    };
    await Promise.all([
      ...parsed.inputs.map((item) => inspectDeclaration(item, "input")),
      ...parsed.observationFiles.map((item) => inspectDeclaration(item, "observation")),
    ]);
    const entryToken = parsed.entrypoint.trim().split(/\s+/)[0];
    if (entryToken.startsWith("./") || entryToken.startsWith("../")) {
      try { await access(resolve(recipeRoot, entryToken), constants.R_OK | constants.X_OK); }
      catch { issues.push(issue("manifest", "entrypoint_missing", `entrypoint file is missing or unreadable: ${entryToken}`, "recipe", "Add an executable Recipe entrypoint such as ./Allrun.")); }
    }
    if (["bash", "/bin/bash", "sh", "/bin/sh"].includes(entryToken)) {
      const script = parsed.entrypoint.trim().split(/\s+/)[1];
      if (!script) issues.push(issue("manifest", "entrypoint_script_missing", "shell entrypoint does not name a script", "recipe", "Name the Recipe script or use ./Allrun."));
      else {
        try { await access(resolve(recipeRoot, script), constants.R_OK); }
        catch { issues.push(issue("manifest", "entrypoint_missing", `entrypoint script is missing or unreadable: ${script}`, "recipe", `Add ${script} or correct entrypoint.`)); }
      }
    }
    const pythonFiles = [...parsed.observe.matchAll(/(?:^|\s)([^\s'\"]+\.py)(?=\s|$)/g)].map((match) => match[1]);
    for (const file of pythonFiles) {
      try { await access(resolve(recipeRoot, file), constants.R_OK); }
      catch { issues.push(issue("manifest", "observer_missing", `observer Python file is missing or unreadable: ${file}`, "recipe", `Add ${file} and declare it in observation_files.`)); }
    }
    if (/(^|\s)python(?:3)?(\s|$)/.test(parsed.observe) && !parsed.observe.includes("uv run --offline --frozen")) {
      issues.push(issue("manifest", "observer_python_unlocked", "Observer uses an ambient Python command", "recipe", "Use uv run --offline --frozen --project \"$PI_CAD_PYTHON_PROJECT\" python ..."));
    }
    try { selectSimulationOutputs(parsed, input.outputs); }
    catch (error) { issues.push(issue("validate", "outputs_invalid", error instanceof Error ? error.message : String(error), "recipe", "Omit outputs for the mandatory primary floor or request only declared additional exports.")); }
  }

  const [recipeResult, runtimeResult] = await Promise.allSettled([
    issues.some((item) => item.stage === "manifest" || item.stage === "inputs") ? Promise.reject(new Error("Recipe preflight already found path or manifest issues")) : loadSimulationRecipe(input.cwd, input.recipePath),
    input.runner.resolveRuntime(input.cwd, input.backend, input.runtime),
  ]);
  if (recipeResult.status === "rejected" && !issues.some((item) => item.stage === "manifest" || item.stage === "inputs")) {
    issues.push(issue("inputs", "recipe_closure_invalid", recipeResult.reason instanceof Error ? recipeResult.reason.message : String(recipeResult.reason), "input", "Repair Recipe/input paths, symlinks, or declared closure."));
  }
  if (runtimeResult.status === "rejected") {
    issues.push(issue("runtime", "runtime_unavailable", runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason), "runtime", "Use a runtime advertised ready in the Current Action Card or repair/bootstrap the exact managed runtime."));
  }
  if (issues.length || recipeResult.status === "rejected" || runtimeResult.status === "rejected") {
    throw new SimulationPreflightError(simulationFailure({
      stage: issues[0]?.stage ?? "manifest",
      code: "preflight_failed",
      retryable: true,
      likelyOwner: issues[0]?.likelyOwner ?? "recipe",
      suggestedAction: "Fix the complete issue list, then call cad_simulate once.",
      message: `${issues.length} preflight issue(s) found; compute was not started.`,
      issues,
    }));
  }
  const recipe = recipeResult.value;
  return { recipe, selectedOutputs: selectSimulationOutputs(recipe.manifest, input.outputs), runtimeIdentity: runtimeResult.value };
}
