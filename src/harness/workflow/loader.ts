import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseAllDocuments } from "yaml";

import { jsonValue, type JsonValue } from "../canonical.ts";
import type { RegistrySet } from "../registry.ts";
import { compileWorkflowDefinition } from "./compiler.ts";
import type { ProjectWorkflowSelectionV1, WorkflowDefinitionV1, WorkflowSnapshotV1 } from "./types.ts";

export const DEFAULT_WORKFLOW_SOURCE = "builtin:mechanical/intake@1";

export type BuiltinWorkflowResolver = (parameters: Record<string, JsonValue>) => WorkflowDefinitionV1;

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function parseYamlDocument(text: string, where: string): unknown {
  const documents = parseAllDocuments(text, { schema: "core", uniqueKeys: true, merge: false });
  if (documents.length !== 1) throw new Error(`${where} must contain exactly one YAML document`);
  const document = documents[0]!;
  if (document.errors.length) throw new Error(`${where} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  if (document.warnings.length) throw new Error(`${where} has unsupported YAML: ${document.warnings.map((warning) => warning.message).join("; ")}`);
  const value = document.toJS({ maxAliasCount: 0 });
  return jsonValue(value, where);
}

export function parseProjectWorkflowSelection(value: unknown): ProjectWorkflowSelectionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pi-cad.yaml must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 1 || Object.keys(raw).some((key) => !["schema", "workflow"].includes(key))) throw new Error("invalid pi-cad.yaml schema");
  if (!raw.workflow || typeof raw.workflow !== "object" || Array.isArray(raw.workflow)) throw new Error("pi-cad.yaml.workflow is required");
  const workflow = raw.workflow as Record<string, unknown>;
  if (Object.keys(workflow).some((key) => !["source", "parameters"].includes(key)) || typeof workflow.source !== "string" || !workflow.source) throw new Error("invalid pi-cad.yaml workflow selection");
  if (workflow.parameters !== undefined && (!workflow.parameters || typeof workflow.parameters !== "object" || Array.isArray(workflow.parameters))) throw new Error("workflow.parameters must be an object");
  return { schema: 1, workflow: { source: workflow.source, parameters: jsonValue(workflow.parameters ?? {}) as Record<string, JsonValue> } };
}

export async function loadProjectWorkflowSelection(cwd: string): Promise<ProjectWorkflowSelectionV1> {
  const path = resolve(cwd, "pi-cad.yaml");
  try {
    return parseProjectWorkflowSelection(parseYamlDocument(await readFile(path, "utf-8"), "pi-cad.yaml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, workflow: { source: DEFAULT_WORKFLOW_SOURCE, parameters: {} } };
    throw error;
  }
}

export async function loadWorkflowSnapshot(input: {
  cwd: string;
  selection: ProjectWorkflowSelectionV1;
  builtins: ReadonlyMap<string, BuiltinWorkflowResolver>;
  registries: RegistrySet;
}): Promise<WorkflowSnapshotV1> {
  const { source, parameters } = input.selection.workflow;
  const builtin = input.builtins.get(source);
  if (builtin) return compileWorkflowDefinition(builtin(parameters), input.registries);
  if (source.startsWith("builtin:")) throw new Error(`unknown builtin workflow: ${source}`);
  if (isAbsolute(source) || source.split(/[\\/]+/).includes("..") || !/\.ya?ml$/i.test(source)) throw new Error(`workflow source must be a project-relative YAML path: ${source}`);
  const root = await realpath(input.cwd);
  const path = await realpath(resolve(root, source));
  if (!inside(root, path)) throw new Error(`workflow source escapes project root: ${source}`);
  return compileWorkflowDefinition(parseYamlDocument(await readFile(path, "utf-8"), source), input.registries);
}
