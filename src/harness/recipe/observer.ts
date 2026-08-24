import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, jsonValue, type JsonValue } from "../canonical.ts";
import type { RegistrySet } from "../registry.ts";
import { TransactionStore } from "../transaction-store.ts";
import { hashRecipePath, hashRecipeProgram, loadRecipe } from "./compiler.ts";
import type { LoadedRecipeV1, RecipeObservationSnapshotV1, RecipeProgramV1, RecipeRunRecordV1, RecipeRuntimeV1 } from "./types.ts";

interface ProgramFile {
  path: string;
  content: Buffer;
  size: number;
  sha256: string;
  mode: number;
}

interface OverlayIndexV1 {
  schema: 1;
  roots: string[];
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function fileDigest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fileHash(path: string): Promise<string> {
  return fileDigest(await readFile(path));
}

function immutableDefinition(recipe: LoadedRecipeV1): JsonValue {
  const { observer: _observer, actions: _actions, ...common } = recipe.definition;
  return jsonValue(common);
}

function inputContract(recipe: LoadedRecipeV1): JsonValue {
  return jsonValue(recipe.inputs.map(({ path, role, type, projectPath, sha256 }) => ({ path, role, type, projectPath, sha256 })));
}

async function collectProgramFiles(recipeRoot: string, program: RecipeProgramV1): Promise<ProgramFile[]> {
  const files = new Map<string, ProgramFile>();
  const visit = async (absolute: string): Promise<void> => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Recipe observer closure contains a symlink: ${absolute}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) await visit(join(absolute, entry));
      return;
    }
    if (!info.isFile()) throw new Error(`unsupported Recipe observer closure entry: ${absolute}`);
    const canonical = await realpath(absolute);
    if (!inside(recipeRoot, canonical)) throw new Error(`Recipe observer closure escapes its root: ${absolute}`);
    const path = relative(recipeRoot, canonical).split(sep).join("/");
    const content = await readFile(canonical);
    files.set(path, { path, content, size: content.length, sha256: fileDigest(content), mode: info.mode & 0o777 });
  };
  for (const path of program.files) await visit(resolve(recipeRoot, path));
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function installObserverOverlay(input: {
  runDirectory: string;
  recipeRoot: string;
  initialRoots: string[];
  nextRoots: string[];
  files: ProgramFile[];
  protectedRoots: string[];
}): Promise<void> {
  for (const root of input.nextRoots) {
    if (pathsOverlap(root, "pi-recipe.yaml") || input.protectedRoots.some((protectedRoot) => pathsOverlap(root, protectedRoot))) {
      throw new Error(`revised observer closure overlaps frozen compute/input state: ${root}`);
    }
  }
  const overlayStore = new TransactionStore(join(input.runDirectory, "observer-overlay"));
  const head = await overlayStore.readHead();
  const previous = await overlayStore.readJson<OverlayIndexV1>("roots.json");
  const roots = [...new Set([...(previous?.roots ?? input.initialRoots), ...input.nextRoots])].sort();
  await overlayStore.commit({
    expectedGeneration: head?.generation ?? 0,
    payloads: { "roots.json": jsonValue({ schema: 1, roots }) },
    event: { type: "RecipeObserverOverlayPrepared", data: { roots: input.nextRoots } },
  });
  const shallowRoots = roots.filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)));
  for (const root of shallowRoots) {
    const target = resolve(input.recipeRoot, root);
    if (!inside(input.recipeRoot, target) || target === resolve(input.recipeRoot)) throw new Error(`unsafe observer overlay root: ${root}`);
    await rm(target, { recursive: true, force: true });
  }
  for (const file of input.files) {
    const target = resolve(input.recipeRoot, file.path);
    if (!inside(input.recipeRoot, target)) throw new Error(`unsafe observer overlay file: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: "wx" });
    await chmod(target, file.mode);
  }
}

function verifySourceRevision(source: LoadedRecipeV1, frozen: LoadedRecipeV1, record: RecipeRunRecordV1): void {
  if (source.definition.id !== record.recipeId || source.definition.kind !== record.recipeKind || source.definition.version !== record.recipeVersion) throw new Error("Recipe identity changed; prepare a new run");
  if (source.definition.runtimeProfile !== record.runtimeIdentity.profileId) throw new Error("Recipe runtime changed; prepare a new run");
  if (source.actionHashes[record.action] !== record.actionHash) throw new Error("Recipe compute changed; prepare a new run");
  if (canonicalJson(immutableDefinition(source)) !== canonicalJson(immutableDefinition(frozen))) throw new Error("Recipe non-observer contract changed; prepare a new run");
  if (canonicalJson(inputContract(source)) !== canonicalJson(inputContract(frozen))) throw new Error("Recipe inputs changed; prepare a new run");
  for (const item of source.inputs) if (record.inputHashes[item.projectPath] !== item.sha256) throw new Error(`Recipe input changed; prepare a new run: ${item.projectPath}`);
  for (const name of record.requestedOutputs) if (!source.definition.exports[name]) throw new Error(`Recipe requested output changed; prepare a new run: ${name}`);
}

export async function observeRecipeRun(input: {
  cwd: string;
  directory: string;
  record: RecipeRunRecordV1;
  registries: RegistrySet;
  runtime: RecipeRuntimeV1;
  signal?: AbortSignal;
}): Promise<RecipeObservationSnapshotV1> {
  const workspace = join(input.directory, "workspace");
  const frozenBefore = await loadRecipe(workspace, input.record.sourceRecipePath, input.registries);
  const source = await loadRecipe(input.cwd, input.record.sourceRecipePath, input.registries);
  verifySourceRevision(source, frozenBefore, input.record);
  const identity = await input.runtime.qualify(input.cwd, source.definition.runtimeProfile);
  if (canonicalJson(identity) !== canonicalJson(input.record.runtimeIdentity)) throw new Error("Recipe runtime identity changed before observation; prepare a new run");

  const observerFiles = await collectProgramFiles(source.recipeRoot, source.definition.observer);
  const inputRoots = frozenBefore.inputs
    .filter((item) => item.projectPath === frozenBefore.recipePath || item.projectPath.startsWith(`${frozenBefore.recipePath}/`))
    .map((item) => relative(frozenBefore.recipePath, item.projectPath).split(sep).join("/"));
  await installObserverOverlay({
    runDirectory: input.directory,
    recipeRoot: frozenBefore.recipeRoot,
    initialRoots: frozenBefore.definition.observer.files,
    nextRoots: source.definition.observer.files,
    files: observerFiles,
    protectedRoots: [...frozenBefore.definition.actions[input.record.action]!.files, ...inputRoots],
  });

  const observationId = `observation-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(input.directory, "observations", observationId);
  const logs = join(directory, "logs");
  await mkdir(logs, { recursive: true });
  const observationFile = join(workspace, `.pi-recipe-observation-${observationId}.json`);
  let observerResult;
  try {
    observerResult = await input.runtime.execute({
      cwd: input.cwd,
      workspace,
      recipeDirectory: frozenBefore.recipeRoot,
      argv: source.definition.observer.argv,
      environment: {
        PI_RECIPE_RUN_ID: input.record.runId,
        PI_RECIPE_PATH: source.recipePath,
        PI_RECIPE_ACTION: input.record.action,
        PI_RECIPE_RUNTIME_PROFILE: source.definition.runtimeProfile,
        PI_RECIPE_OBSERVATION_ID: observationId,
        PI_RECIPE_OBSERVATION_FILE: observationFile,
        PI_SIM_RUN_ID: input.record.runId,
        PI_SIM_OBSERVATION_FILE: observationFile,
      },
      timeoutMs: source.definition.observer.timeoutSeconds * 1000,
      stdoutPath: join(logs, "stdout.log"), stderrPath: join(logs, "stderr.log"), signal: input.signal,
    });
  } catch (error) {
    observerResult = { exitCode: 127, durationMs: 0, stdout: "", stderr: String(error) };
  }

  const frozenAfter = await loadRecipe(workspace, input.record.sourceRecipePath, input.registries);
  if (await hashRecipeProgram(frozenAfter.recipeRoot, frozenAfter.definition.actions[input.record.action]!, frozenAfter.definition, "action", input.record.action) !== input.record.actionHash) throw new Error("observer modified a frozen Recipe program");
  if (canonicalJson(immutableDefinition(frozenAfter)) !== canonicalJson(immutableDefinition(frozenBefore))) throw new Error("observer modified the frozen Recipe manifest");
  for (const item of frozenAfter.inputs) if (input.record.inputHashes[item.projectPath] !== await hashRecipePath(workspace, item.absolutePath)) throw new Error(`observer modified a frozen Recipe input: ${item.projectPath}`);
  for (const file of observerFiles) {
    const target = resolve(frozenAfter.recipeRoot, file.path);
    if ((await lstat(target)).mode % 0o1000 !== file.mode || await fileHash(target) !== file.sha256) throw new Error(`observer modified its snapshotted program: ${file.path}`);
  }

  const warnings: string[] = [];
  const exports: RecipeObservationSnapshotV1["exports"] = [];
  if (observerResult.exitCode === 0) {
    const payload = JSON.parse(await readFile(observationFile, "utf-8")) as { schema?: unknown; exports?: unknown };
    if (payload.schema !== 1 || !payload.exports || typeof payload.exports !== "object" || Array.isArray(payload.exports)) throw new Error("invalid Recipe observation schema");
    const values = payload.exports as Record<string, unknown>;
    for (const name of Object.keys(values)) if (!source.definition.exports[name]) throw new Error(`observer emitted undeclared export: ${name}`);
    for (const [name, declaration] of Object.entries(source.definition.exports).filter(([name]) => input.record.requestedOutputs.includes(name))) {
      const raw = values[name];
      if (raw === undefined) {
        throw new Error(`observer omitted requested export: ${name}`);
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid observer export: ${name}`);
      const value = raw as Record<string, unknown>;
      if (value.type !== declaration.type) throw new Error(`observer export type mismatch: ${name}`);
      if (declaration.type === "scalar") {
        if (typeof value.value !== "number" || !Number.isFinite(value.value)) throw new Error(`observer scalar is not finite: ${name}`);
        if (declaration.unit && value.unit !== declaration.unit) throw new Error(`observer scalar unit mismatch: ${name}`);
        exports.push({ name, type: declaration.type, value: value.value, ...(declaration.unit ? { unit: declaration.unit } : {}) });
      } else {
        if (typeof value.path !== "string" || !value.path || isAbsolute(value.path) || value.path.split(/[\\/]+/).includes("..")) throw new Error(`observer export path is invalid: ${name}`);
        const path = await realpath(resolve(workspace, value.path));
        if (!inside(workspace, path)) throw new Error(`observer export escapes workspace: ${name}`);
        exports.push({ name, type: declaration.type, path: relative(workspace, path).split(sep).join("/"), sha256: await fileHash(path) });
      }
    }
  } else warnings.push(`observer exited ${observerResult.exitCode}`);

  const observerContract = jsonValue({ observer: source.definition.observer, exports: source.definition.exports });
  const snapshot: RecipeObservationSnapshotV1 = {
    schema: 1, runId: input.record.runId, observationId, createdAt: new Date().toISOString(), observerHash: source.observerHash,
    observerContract,
    observerProgramFiles: observerFiles.map(({ path, size, sha256, mode }) => ({ path, size, sha256, mode })),
    observerResult,
    validForCommit: input.record.status === "completed" && observerResult.exitCode === 0 && input.record.requestedOutputs.length === exports.length,
    exports, warnings,
  };
  const payloads: Record<string, Buffer | JsonValue> = { "snapshot.json": jsonValue(snapshot) };
  for (const file of observerFiles) payloads[`program/${file.path}`] = file.content;
  const store = new TransactionStore(join(directory, "record"));
  await store.commit({ expectedGeneration: 0, payloads, event: { type: "RecipeObserved", data: { observationId, observerHash: snapshot.observerHash, validForCommit: snapshot.validForCommit } } });
  return snapshot;
}
