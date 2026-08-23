import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, cp, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { CadProjectStore, nowIso, sha256File } from "../../shared/store.ts";
import { hashSimulationPath, loadSimulationRecipe, selectSimulationOutputs, type LoadedSimulationRecipe, type SimulationRecipeManifest } from "./protocol.ts";
import { validateObservationFile, type ValidatedObservation } from "./observation.ts";

export interface RuntimeIdentity {
  backend: string;
  runtime: string;
  platform: string;
  resolvedVersion: string;
  digest: string;
  launcher: string;
}

export interface SimulationCommandResult {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  diagnostics: string[];
}

export interface SimulationCommandRunner {
  resolveRuntime(cwd: string, backend: string, runtime: string): Promise<RuntimeIdentity>;
  execute(input: {
    cwd: string;
    workspace: string;
    recipeDirectory: string;
    command: string;
    environment: Record<string, string>;
    stdoutPath: string;
    stderrPath: string;
    timeoutMs: number;
    backend: string;
    runtime: string;
  }): Promise<SimulationCommandResult>;
}

export type SimulationRunStatus = "running" | "completed" | "failed" | "interrupted";

export interface SimulationRunRecord {
  schema: 1;
  runId: string;
  workflowRunId: string;
  status: SimulationRunStatus;
  createdAt: string;
  completedAt?: string;
  sourceRecipePath: string;
  manifest: SimulationRecipeManifest;
  computeRecipeHash: string;
  initialObservationProgramHash: string;
  computeIdentity: string;
  rawProjectHash: string;
  backend: string;
  runtime: string;
  runtimeIdentity: RuntimeIdentity;
  inputs: Array<{ declaration: string; projectPath: string; sha256: string; kind: "file" | "directory" }>;
  entrypoint?: SimulationCommandResult;
  latestObservationId?: string;
}

export interface ObservationSnapshotRecord {
  schema: 1;
  runId: string;
  observationId: string;
  createdAt: string;
  observationProgramHash: string;
  requestedOutputs: string[];
  validForCommit: boolean;
  observeResult: SimulationCommandResult;
  exports: Array<{
    name: string;
    type: string;
    path?: string;
    sha256?: string;
    contentAddress?: string;
    plotPath?: string;
    summary?: string;
    value?: number;
    unit?: string;
  }>;
  warnings: string[];
}

export interface SimulationRunResult {
  run: SimulationRunRecord;
  observation?: ObservationSnapshotRecord;
  validatedObservation?: ValidatedObservation;
  runDirectory: string;
  observationDirectory?: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function projectPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function insidePath(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

async function currentWorkflowRun(cwd: string): Promise<string> {
  const store = new CadProjectStore(cwd);
  const runId = await store.currentRunId();
  if (!runId) throw new Error("simulation requires an active Pi-CAD workflow");
  return runId;
}

export function simulationRoot(cwd: string, workflowRunId: string): string {
  return join(resolve(cwd), ".pi-cad", "runs", workflowRunId, "simulation");
}

async function nextId(root: string, prefix: string): Promise<string> {
  const names = await readdir(root).catch(() => []);
  const max = names.reduce((value, name) => {
    const match = name.match(new RegExp(`^${prefix}-(\\d+)$`));
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

async function copyDeclaredProject(recipe: LoadedSimulationRecipe, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const recipeTarget = join(destination, recipe.recipePath);
  await mkdir(dirname(recipeTarget), { recursive: true });
  await cp(recipe.recipeRoot, recipeTarget, { recursive: true, force: false, errorOnExist: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  for (const input of recipe.inputs) {
    const target = join(destination, input.projectPath);
    await mkdir(dirname(target), { recursive: true });
    if (insidePath(recipe.recipeRoot, input.absolutePath)) continue;
    await cp(input.absolutePath, target, { recursive: input.kind === "directory", force: false, errorOnExist: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function pruneObservationWorkspace(workspace: string, keep: string[]): Promise<void> {
  const roots = keep.map((path) => resolve(path));
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const retained = roots.some((root) => root === absolute || insidePath(absolute, root));
      if (!retained) {
        await rm(absolute, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await visit(absolute);
      }
    }
  };
  await visit(workspace);
}

async function internObservationFiles(runDirectory: string, validated: ValidatedObservation): Promise<void> {
  for (const entry of validated.selected) {
    if (!entry.absolutePath || !entry.sha256) continue;
    const relativeObject = join("objects", "sha256", entry.sha256.slice(0, 2), entry.sha256);
    const objectPath = join(runDirectory, relativeObject);
    await mkdir(dirname(objectPath), { recursive: true });
    try {
      await link(entry.absolutePath, objectPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        try {
          await copyFile(entry.absolutePath, objectPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
        }
      }
    }
    if (await sha256File(objectPath) !== entry.sha256) throw new Error(`content-address collision for observation export ${entry.name}`);
    await chmod(objectPath, 0o444);
    await rm(entry.absolutePath, { force: true });
    try {
      await link(objectPath, entry.absolutePath);
    } catch {
      await copyFile(objectPath, entry.absolutePath, constants.COPYFILE_FICLONE);
    }
  }
}

export async function readSimulationRun(cwd: string, workflowRunId: string, runId: string): Promise<{ record: SimulationRunRecord; directory: string }> {
  const directory = join(simulationRoot(cwd, workflowRunId), runId);
  let record = JSON.parse(await readFile(join(directory, "run.json"), "utf-8")) as SimulationRunRecord;
  if (record.schema !== 1 || record.runId !== runId || record.workflowRunId !== workflowRunId) throw new Error(`invalid simulation run record: ${runId}`);
  if (record.status === "running") {
    record = { ...record, status: "interrupted", completedAt: nowIso() };
    await writeJson(join(directory, "run.json"), record);
    await new CadProjectStore(cwd).appendEvent("SimulationRunInterrupted", { runId }).catch(() => {});
  }
  return { record, directory };
}

export async function readObservationSnapshot(runDirectory: string, observationId: string): Promise<ObservationSnapshotRecord> {
  const path = join(runDirectory, "observations", observationId, "snapshot.json");
  const record = JSON.parse(await readFile(path, "utf-8")) as ObservationSnapshotRecord;
  if (record.schema !== 1 || record.observationId !== observationId) throw new Error(`invalid observation snapshot: ${observationId}`);
  return record;
}

async function runObservation(input: {
  cwd: string;
  runner: SimulationCommandRunner;
  recipe: LoadedSimulationRecipe;
  run: SimulationRunRecord;
  runDirectory: string;
  selectedOutputs: string[];
}): Promise<{ snapshot: ObservationSnapshotRecord; validated?: ValidatedObservation; directory: string }> {
  await verifyRawProject(input.runDirectory, input.run);
  const observationsRoot = join(input.runDirectory, "observations");
  await mkdir(observationsRoot, { recursive: true });
  const observationId = await nextId(observationsRoot, "obs");
  const directory = join(observationsRoot, observationId);
  const workspace = join(directory, "work");
  const logs = join(directory, "logs");
  const plots = join(directory, "plots");
  await mkdir(logs, { recursive: true });
  await cp(join(input.runDirectory, "raw-project"), workspace, { recursive: true, force: false, errorOnExist: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  // Re-observation takes only the explicitly mutable observation program and
  // the current manifest's observe/export projection. Compute inputs stay the
  // frozen raw-project copy.
  await cp(input.recipe.manifestPath, join(workspace, input.recipe.recipePath, "pi-sim.toml"), { force: true });
  for (const declaration of input.run.manifest.observationFiles) {
    const source = resolve(input.recipe.recipeRoot, declaration);
    const target = resolve(workspace, input.recipe.recipePath, declaration);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, dereference: true });
  }
  const observationFile = join(workspace, ".pi-sim-observations.json");
  const stdoutPath = join(logs, "stdout.log");
  const stderrPath = join(logs, "stderr.log");
  let observeResult: SimulationCommandResult;
  try {
    observeResult = await input.runner.execute({
      cwd: input.cwd,
      workspace,
      recipeDirectory: join(workspace, input.recipe.recipePath),
      command: input.recipe.manifest.observe,
      environment: {
        PI_SIM_OBSERVATION_FILE: observationFile,
        PI_SIM_RUN_ID: input.run.runId,
        PI_SIM_OBSERVATION_ID: observationId,
      },
      stdoutPath,
      stderrPath,
      timeoutMs: 3_600_000,
      backend: input.run.backend,
      runtime: input.run.runtime,
    });
  } catch (error) {
    observeResult = { exitCode: 127, durationMs: 0, stdout: "", stderr: String(error), diagnostics: [String(error).slice(0, 8192)] };
  }
  let validated: ValidatedObservation | undefined;
  try {
    validated = await validateObservationFile({
      manifest: input.recipe.manifest,
      observationFile,
      workspace,
      selectedNames: input.selectedOutputs,
      plotDir: plots,
      computeSucceeded: input.run.status === "completed" && observeResult.exitCode === 0,
    });
  } catch (error) {
    if (input.run.status === "completed" && observeResult.exitCode === 0) throw error;
  }
  if (validated) await internObservationFiles(input.runDirectory, validated);
  const snapshot: ObservationSnapshotRecord = {
    schema: 1,
    runId: input.run.runId,
    observationId,
    createdAt: nowIso(),
    observationProgramHash: input.recipe.observationProgramHash,
    requestedOutputs: input.selectedOutputs,
    validForCommit: validated?.validForCommit ?? false,
    observeResult,
    exports: (validated?.selected ?? []).map((entry) => ({
      name: entry.name,
      type: entry.declaration.type,
      ...(entry.absolutePath ? { path: projectPath(directory, entry.absolutePath) } : {}),
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(entry.sha256 ? { contentAddress: `sha256:${entry.sha256}` } : {}),
      ...(entry.plotPath ? { plotPath: projectPath(directory, entry.plotPath) } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.declaration.type === "scalar" ? { value: (entry.materialized as { value: number }).value, unit: entry.declaration.unit } : {}),
    })),
    warnings: validated?.warnings ?? ["observer did not produce a valid ObservationBundle"],
  };
  await writeJson(join(directory, "snapshot.json"), snapshot);
  await pruneObservationWorkspace(workspace, [observationFile, ...(validated?.selected.flatMap((entry) => entry.absolutePath ? [entry.absolutePath] : []) ?? [])]);
  return { snapshot, validated, directory };
}

export async function createSimulationRun(input: {
  cwd: string;
  backend: string;
  runtime: string;
  recipePath: string;
  outputs?: string[];
  runner: SimulationCommandRunner;
}): Promise<SimulationRunResult> {
  const workflowRunId = await currentWorkflowRun(input.cwd);
  const recipe = await loadSimulationRecipe(input.cwd, input.recipePath);
  const selectedOutputs = selectSimulationOutputs(recipe.manifest, input.outputs);
  const runtimeIdentity = await input.runner.resolveRuntime(input.cwd, input.backend, input.runtime);
  const root = simulationRoot(input.cwd, workflowRunId);
  await mkdir(root, { recursive: true });
  const runId = await nextId(root, "sim");
  const runDirectory = join(root, runId);
  const rawProject = join(runDirectory, "raw-project");
  const logs = join(runDirectory, "logs");
  await mkdir(logs, { recursive: true });
  await cp(recipe.recipeRoot, join(runDirectory, "recipe"), { recursive: true, force: false, errorOnExist: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  await copyDeclaredProject(recipe, rawProject);
  const computeIdentity = createHash("sha256").update(stable({
    computeRecipeHash: recipe.computeRecipeHash,
    inputs: recipe.inputs.map((item) => ({ path: item.projectPath, sha256: item.sha256 })),
    backend: input.backend,
    runtimeIdentity,
  })).digest("hex");
  let run: SimulationRunRecord = {
    schema: 1,
    runId,
    workflowRunId,
    status: "running",
    createdAt: nowIso(),
    sourceRecipePath: recipe.recipePath,
    manifest: recipe.manifest,
    computeRecipeHash: recipe.computeRecipeHash,
    initialObservationProgramHash: recipe.observationProgramHash,
    computeIdentity,
    rawProjectHash: "pending",
    backend: input.backend,
    runtime: input.runtime,
    runtimeIdentity,
    inputs: recipe.inputs.map((item) => ({ declaration: item.declaration, projectPath: item.projectPath, sha256: item.sha256, kind: item.kind })),
  };
  await writeJson(join(runDirectory, "run.json"), run);
  let entrypoint: SimulationCommandResult;
  try {
    entrypoint = await input.runner.execute({
      cwd: input.cwd,
      workspace: rawProject,
      recipeDirectory: join(rawProject, recipe.recipePath),
      command: recipe.manifest.entrypoint,
      environment: { PI_SIM_RUN_ID: runId },
      stdoutPath: join(logs, "stdout.log"),
      stderrPath: join(logs, "stderr.log"),
      timeoutMs: 12 * 60 * 60 * 1000,
      backend: input.backend,
      runtime: input.runtime,
    });
  } catch (error) {
    entrypoint = { exitCode: 127, durationMs: 0, stdout: "", stderr: String(error), diagnostics: [String(error).slice(0, 8192)] };
  }
  let rawProjectHash: string;
  try {
    rawProjectHash = (await hashSimulationPath(rawProject, rawProject)).hash;
  } catch (error) {
    entrypoint = { ...entrypoint, exitCode: entrypoint.exitCode || 126, diagnostics: [...entrypoint.diagnostics, `raw-project freeze failed: ${String(error)}`] };
    rawProjectHash = "invalid";
  }
  run = { ...run, status: entrypoint.exitCode === 0 ? "completed" : "failed", completedAt: nowIso(), entrypoint, rawProjectHash };
  await writeJson(join(runDirectory, "run.json"), run);
  let observation: Awaited<ReturnType<typeof runObservation>> | undefined;
  try {
    observation = await runObservation({ cwd: input.cwd, runner: input.runner, recipe, run, runDirectory, selectedOutputs });
    run = { ...run, latestObservationId: observation.snapshot.observationId };
    await writeJson(join(runDirectory, "run.json"), run);
  } catch (error) {
    if (run.status === "completed") throw error;
  }
  return { run, observation: observation?.snapshot, validatedObservation: observation?.validated, runDirectory, observationDirectory: observation?.directory };
}

export async function createObservationSnapshot(input: {
  cwd: string;
  workflowRunId: string;
  runId: string;
  outputs?: string[];
  runner: SimulationCommandRunner;
}): Promise<SimulationRunResult> {
  const loaded = await readSimulationRun(input.cwd, input.workflowRunId, input.runId);
  const recipe = await loadSimulationRecipe(input.cwd, loaded.record.sourceRecipePath);
  if (recipe.computeRecipeHash !== loaded.record.computeRecipeHash) throw new Error("compute Recipe changed; call cad_simulate to create a new run");
  if (stable(recipe.manifest.observationFiles) !== stable(loaded.record.manifest.observationFiles)) throw new Error("observation_files declaration changed; call cad_simulate to create a new run");
  const currentInputs = new Map(recipe.inputs.map((item) => [item.projectPath, item.sha256]));
  for (const frozen of loaded.record.inputs) if (currentInputs.get(frozen.projectPath) !== frozen.sha256) throw new Error(`declared simulation input changed: ${frozen.projectPath}; call cad_simulate`);
  const selectedOutputs = selectSimulationOutputs(recipe.manifest, input.outputs);
  const observation = await runObservation({ cwd: input.cwd, runner: input.runner, recipe, run: loaded.record, runDirectory: loaded.directory, selectedOutputs });
  const run = { ...loaded.record, latestObservationId: observation.snapshot.observationId };
  await writeJson(join(loaded.directory, "run.json"), run);
  return { run, observation: observation.snapshot, validatedObservation: observation.validated, runDirectory: loaded.directory, observationDirectory: observation.directory };
}

export async function verifySnapshotFiles(runDirectory: string, snapshot: ObservationSnapshotRecord): Promise<void> {
  const directory = join(runDirectory, "observations", snapshot.observationId);
  for (const entry of snapshot.exports) {
    if (!entry.path || !entry.sha256) continue;
    const absolute = resolve(directory, entry.path);
    if (await sha256File(absolute) !== entry.sha256) throw new Error(`observation export hash changed: ${entry.name}`);
    if (entry.contentAddress) {
      if (entry.contentAddress !== `sha256:${entry.sha256}`) throw new Error(`invalid observation content address: ${entry.name}`);
      const objectPath = join(runDirectory, "objects", "sha256", entry.sha256.slice(0, 2), entry.sha256);
      if (await sha256File(objectPath) !== entry.sha256) throw new Error(`observation content object changed: ${entry.name}`);
    }
  }
}

export async function verifyRawProject(runDirectory: string, run: SimulationRunRecord): Promise<void> {
  if (!run.rawProjectHash || run.rawProjectHash === "pending" || run.rawProjectHash === "invalid") throw new Error(`simulation run ${run.runId} has no valid frozen raw-project identity`);
  const rawProject = join(runDirectory, "raw-project");
  const current = await hashSimulationPath(rawProject, rawProject);
  if (current.hash !== run.rawProjectHash) throw new Error(`frozen raw-project changed after compute for ${run.runId}`);
}
