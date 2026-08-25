import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { TransactionStore } from "../transaction-store.ts";
import { harnessRunDirectory } from "../../authority/storage.ts";
import type { RecipeObservationSnapshotV1, RecipeRunRecordV1 } from "./types.ts";

function component(value: string, where: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`${where} is invalid`);
  return value;
}

export async function loadRecipeObservation(input: { directory: string; observationId: string }): Promise<RecipeObservationSnapshotV1> {
  component(input.observationId, "observationId");
  const root = resolve(input.directory, "observations");
  const directory = resolve(root, input.observationId);
  if (!inside(root, directory)) throw new Error("Recipe observation path escapes run storage");
  const snapshot = await new TransactionStore(join(directory, "record")).readJson<RecipeObservationSnapshotV1>("snapshot.json");
  if (!snapshot || snapshot.schema !== 1 || snapshot.observationId !== input.observationId) throw new Error("Recipe observation snapshot is missing or malformed");
  return snapshot;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function loadRecipeRun(input: { cwd: string; workflowRunId: string; recipeRunId: string }): Promise<{ record: RecipeRunRecordV1; directory: string }> {
  component(input.workflowRunId, "workflowRunId");
  component(input.recipeRunId, "recipeRunId");
  const root = resolve(harnessRunDirectory(input.cwd, input.workflowRunId), "recipe-runs");
  const directory = resolve(root, input.recipeRunId);
  if (!inside(root, directory)) throw new Error("Recipe run path escapes run storage");
  const canonical = await realpath(directory);
  if (!inside(root, canonical)) throw new Error("Recipe run symlink escapes run storage");
  const record = await new TransactionStore(join(canonical, "record")).readJson<RecipeRunRecordV1>("run.json");
  if (!record || record.schema !== 1 || record.runId !== input.recipeRunId || record.workflowRunId !== input.workflowRunId) throw new Error("Recipe run record is missing or malformed");
  return { record, directory: canonical };
}
