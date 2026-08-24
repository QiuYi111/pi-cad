import type { JsonValue } from "../canonical.ts";
import type { RecipeObligationBindingV7 } from "../state.ts";

export interface RecipeInputDefinitionV1 {
  path: string;
  role: string;
  type: "file" | "directory";
}

export interface RecipeProgramV1 {
  argv: string[];
  files: string[];
  timeoutSeconds: number;
}

export interface RecipeExportDefinitionV1 {
  type: "image" | "scalar" | "timeseries" | "table" | "field" | "artifact";
  primary: boolean;
  unit?: string;
}

export interface RecipeDefinitionV1 {
  schema: 1;
  id: string;
  version: string;
  kind: string;
  runtimeProfile: string;
  inputs: RecipeInputDefinitionV1[];
  /** Named, argv-form compute entrypoints. The selected name is frozen into each run. */
  actions: Record<string, RecipeProgramV1>;
  observer: RecipeProgramV1;
  exports: Record<string, RecipeExportDefinitionV1>;
  resources: { cpu: number; memoryGiB: number; workspaceGiB: number };
}

export interface LoadedRecipeV1 {
  projectRoot: string;
  recipeRoot: string;
  recipePath: string;
  manifestPath: string;
  definition: RecipeDefinitionV1;
  actionHashes: Record<string, string>;
  observerHash: string;
  inputs: Array<RecipeInputDefinitionV1 & { absolutePath: string; projectPath: string; sha256: string }>;
}

export interface RecipeRuntimeIdentityV1 {
  profileId: string;
  platform: string;
  version: string;
  digest: string;
  launcher: string;
  details?: Record<string, JsonValue>;
}

export interface RecipeExecutionResultV1 {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  terminationReason?: string;
}

export interface RecipeRuntimeV1 {
  qualify(cwd: string, profileId: string): Promise<RecipeRuntimeIdentityV1>;
  execute(input: {
    cwd: string;
    workspace: string;
    recipeDirectory: string;
    argv: string[];
    environment: Record<string, string>;
    timeoutMs: number;
    stdoutPath: string;
    stderrPath: string;
    signal?: AbortSignal;
  }): Promise<RecipeExecutionResultV1>;
}

export interface RecipeRunRecordV1 {
  schema: 1;
  runId: string;
  workflowRunId: string;
  recipeId: string;
  recipeKind: string;
  recipeVersion: string;
  action: string;
  requestedOutputs: string[];
  sourceRecipePath: string;
  obligationBinding?: RecipeObligationBindingV7;
  workflowHash: string;
  registryContractHash: string;
  phaseAtPrepare: string;
  runtimeIdentity: RecipeRuntimeIdentityV1;
  actionHash: string;
  observerHash: string;
  inputHashes: Record<string, string>;
  computeIdentity: string;
  status: "prepared" | "running" | "completed" | "failed" | "interrupted";
  computeResult?: RecipeExecutionResultV1;
  createdAt: string;
  completedAt?: string;
}

export interface RecipeObservationSnapshotV1 {
  schema: 1;
  runId: string;
  observationId: string;
  createdAt: string;
  observerHash: string;
  observerContract: JsonValue;
  observerProgramFiles: Array<{ path: string; size: number; sha256: string; mode: number }>;
  observerResult: RecipeExecutionResultV1;
  validForCommit: boolean;
  exports: Array<{ name: string; type: RecipeExportDefinitionV1["type"]; value?: number; unit?: string; path?: string; sha256?: string }>;
  warnings: string[];
}
