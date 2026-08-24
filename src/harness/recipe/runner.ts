import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalDigest, canonicalJson, jsonValue } from "../canonical.ts";
import { prepareRecipeObligation } from "../reducer.ts";
import type { LoadedHarnessRunV7 } from "../run-store.ts";
import type { RegistrySet } from "../registry.ts";
import { TransactionStore } from "../transaction-store.ts";
import { loadRecipe } from "./compiler.ts";
import type { LoadedRecipeV1, RecipeRunRecordV1, RecipeRuntimeV1 } from "./types.ts";

function closureIdentity(recipe: LoadedRecipeV1): string {
  return canonicalJson({
    definition: recipe.definition,
    recipePath: recipe.recipePath,
    actionHashes: recipe.actionHashes,
    observerHash: recipe.observerHash,
    inputs: recipe.inputs.map(({ path, role, type, projectPath, sha256 }) => ({ path, role, type, projectPath, sha256 })),
  });
}

async function copyClosure(recipe: LoadedRecipeV1, workspace: string): Promise<void> {
  const recipeTarget = join(workspace, recipe.recipePath);
  await mkdir(recipeTarget, { recursive: true });
  await cp(recipe.manifestPath, join(recipeTarget, "pi-recipe.yaml"), { force: false, errorOnExist: true, dereference: false, mode: constants.COPYFILE_FICLONE });
  const declared = [...new Set([
    ...Object.values(recipe.definition.actions).flatMap((program) => program.files),
    ...recipe.definition.observer.files,
  ])].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const copiedRoots: string[] = [];
  for (const path of declared) {
    if (copiedRoots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
    const source = join(recipe.recipeRoot, path);
    const info = await lstat(source);
    const target = join(recipeTarget, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: info.isDirectory(), force: false, errorOnExist: true, dereference: false, mode: constants.COPYFILE_FICLONE });
    if (info.isDirectory()) copiedRoots.push(path);
  }
  for (const input of recipe.inputs) {
    const target = join(workspace, input.projectPath);
    try { await lstat(target); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(target), { recursive: true });
    await cp(input.absolutePath, target, { recursive: input.type === "directory", force: false, errorOnExist: true, dereference: false, mode: constants.COPYFILE_FICLONE });
  }
}

export async function prepareAndRunRecipe(input: {
  cwd: string;
  harness: LoadedHarnessRunV7;
  registries: RegistrySet;
  recipePath: string;
  expectedKind?: string;
  action?: string;
  obligationRef?: string;
  outputs?: string[];
  runtime: RecipeRuntimeV1;
  signal?: AbortSignal;
}): Promise<{ record: RecipeRunRecordV1; directory: string }> {
  const source = await loadRecipe(input.cwd, input.recipePath, input.registries);
  if (input.expectedKind && source.definition.kind !== input.expectedKind) throw new Error(`Recipe kind mismatch: expected ${input.expectedKind}, got ${source.definition.kind}`);
  const action = input.action ?? (source.definition.actions.run ? "run" : Object.keys(source.definition.actions)[0]!);
  if (!source.definition.actions[action]) throw new Error(`Recipe action is not declared: ${action}`);
  const requestedOutputs = [...new Set([
    ...Object.entries(source.definition.exports).filter(([, declaration]) => declaration.primary).map(([name]) => name),
    ...(input.outputs ?? []),
  ])].sort();
  for (const name of requestedOutputs) if (!source.definition.exports[name]) throw new Error(`Recipe output is not declared: ${name}`);
  const kindRegistration = input.registries.recipeKinds.require(source.definition.kind);
  const bindingPolicy = (kindRegistration.contract.semantics as Record<string, unknown>).obligationBinding;
  if (bindingPolicy === "required" && !input.obligationRef) throw new Error(`Recipe kind requires obligationRef: ${source.definition.kind}`);
  if (bindingPolicy === "forbidden" && input.obligationRef) throw new Error(`Recipe kind forbids obligationRef: ${source.definition.kind}`);
  const binding = input.obligationRef ? prepareRecipeObligation({ state: input.harness.state, workflow: input.harness.workflow, registryContract: input.harness.registryContract, obligationRef: input.obligationRef, recipeKind: source.definition.kind, requestedOutputs }) : undefined;
  const runtimeBefore = await input.runtime.qualify(input.cwd, source.definition.runtimeProfile);
  if (runtimeBefore.profileId !== source.definition.runtimeProfile || !/^[a-f0-9]{64}$/.test(runtimeBefore.digest)) throw new Error("Recipe runtime returned an invalid identity");
  const root = join(input.cwd, ".pi-cad", "runs", input.harness.state.runId, "recipe-runs");
  await mkdir(root, { recursive: true });
  const runId = `recipe-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, runId);
  const staging = `${directory}.staging-${process.pid}`;
  const workspace = join(staging, "workspace");
  let frozen: LoadedRecipeV1;
  try {
    await copyClosure(source, workspace);
    frozen = await loadRecipe(workspace, source.recipePath, input.registries);
    if (closureIdentity(frozen) !== closureIdentity(source)) throw new Error("Recipe or declared input changed between validation and freeze");
    const runtimeAfter = await input.runtime.qualify(input.cwd, source.definition.runtimeProfile);
    if (canonicalJson(runtimeAfter) !== canonicalJson(runtimeBefore)) throw new Error("Recipe runtime identity changed between validation and freeze");
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  frozen = await loadRecipe(join(directory, "workspace"), source.recipePath, input.registries);
  const recordStore = new TransactionStore(join(directory, "record"));
  const createdAt = new Date().toISOString();
  const actionHash = frozen.actionHashes[action];
  if (!actionHash) throw new Error(`frozen Recipe action is not declared: ${action}`);
  const computeIdentity = canonicalDigest({ action, actionHash, inputs: frozen.inputs.map((item) => ({ path: item.projectPath, sha256: item.sha256 })), runtimeIdentity: runtimeBefore, binding });
  let record: RecipeRunRecordV1 = {
    schema: 1, runId, workflowRunId: input.harness.state.runId, recipeId: frozen.definition.id, recipeKind: frozen.definition.kind, recipeVersion: frozen.definition.version, action, requestedOutputs,
    sourceRecipePath: source.recipePath, ...(binding ? { obligationBinding: binding } : {}), workflowHash: input.harness.workflow.hash,
    registryContractHash: input.harness.registryContract.hash, phaseAtPrepare: input.harness.state.phase, runtimeIdentity: runtimeBefore,
    actionHash, observerHash: frozen.observerHash, inputHashes: Object.fromEntries(frozen.inputs.map((item) => [item.projectPath, item.sha256])), computeIdentity,
    status: "prepared", createdAt,
  };
  await recordStore.commit({ expectedGeneration: 0, payloads: { "run.json": jsonValue(record) }, event: { type: "RecipePrepared", data: { runId, recipeKind: record.recipeKind, obligationRef: binding?.obligationRef ?? null } } });
  record = { ...record, status: "running" };
  await recordStore.commit({ expectedGeneration: 1, payloads: { "run.json": jsonValue(record) }, event: { type: "RecipeStarted", data: { runId } } });
  const logs = join(directory, "logs");
  await mkdir(logs, { recursive: true });
  let computeResult;
  try {
    computeResult = await input.runtime.execute({
      cwd: input.cwd,
      workspace: join(directory, "workspace"),
      recipeDirectory: join(directory, "workspace", frozen.recipePath),
      argv: frozen.definition.actions[action]!.argv,
      environment: { PI_RECIPE_RUN_ID: runId, PI_RECIPE_PATH: frozen.recipePath, PI_RECIPE_ACTION: action, PI_RECIPE_RUNTIME_PROFILE: frozen.definition.runtimeProfile },
      timeoutMs: frozen.definition.actions[action]!.timeoutSeconds * 1000,
      stdoutPath: join(logs, "compute.stdout.log"), stderrPath: join(logs, "compute.stderr.log"), signal: input.signal,
    });
  } catch (error) {
    computeResult = { exitCode: 127, durationMs: 0, stdout: "", stderr: String(error) };
  }
  record = { ...record, status: computeResult.exitCode === 0 ? "completed" : "failed", computeResult, completedAt: new Date().toISOString() };
  await recordStore.commit({ expectedGeneration: 2, payloads: { "run.json": jsonValue(record) }, event: { type: "RecipeCompleted", data: { runId, status: record.status, exitCode: computeResult.exitCode } } });
  return { record, directory };
}
