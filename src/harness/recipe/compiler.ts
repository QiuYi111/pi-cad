import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../canonical.ts";
import type { RegistrySet } from "../registry.ts";
import { parseYamlDocument } from "../workflow/loader.ts";
import type { LoadedRecipeV1, RecipeDefinitionV1, RecipeExportDefinitionV1, RecipeInputDefinitionV1, RecipeProgramV1 } from "./types.ts";

const ID = /^[a-z][a-z0-9_]*(?:[.:/-][a-z0-9_]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exact(value: Record<string, unknown>, keys: string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown fields: ${unknown.join(", ")}`);
}

function relativePath(value: unknown, where: string): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.split(/[\\/]+/).includes("..") || value.includes("\0")) throw new Error(`${where} must be a confined relative path`);
  return value.replaceAll("\\", "/");
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function program(value: unknown, where: string): RecipeProgramV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const raw = value as Record<string, unknown>;
  exact(raw, ["argv", "files", "timeoutSeconds"], where);
  if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((item) => typeof item !== "string" || !item || item.includes("\0"))) throw new Error(`${where}.argv must be a non-empty string array`);
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw new Error(`${where}.files must be a non-empty array`);
  const files = raw.files.map((item, index) => relativePath(item, `${where}.files[${index}]`));
  if (new Set(files).size !== files.length) throw new Error(`${where}.files contains duplicates`);
  if (!Number.isInteger(raw.timeoutSeconds) || Number(raw.timeoutSeconds) <= 0) throw new Error(`${where}.timeoutSeconds must be a positive integer`);
  return { argv: raw.argv as string[], files, timeoutSeconds: raw.timeoutSeconds as number };
}

export function compileRecipeDefinition(value: unknown, registries: RegistrySet): RecipeDefinitionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipe must be an object");
  const raw = value as Record<string, unknown>;
  exact(raw, ["schema", "id", "version", "kind", "runtimeProfile", "inputs", "actions", "observer", "exports", "resources"], "Recipe");
  if (raw.schema !== 1 || typeof raw.id !== "string" || !ID.test(raw.id) || typeof raw.version !== "string" || !VERSION.test(raw.version)) throw new Error("invalid Recipe identity");
  if (typeof raw.kind !== "string" || !raw.kind || typeof raw.runtimeProfile !== "string" || !raw.runtimeProfile) throw new Error("Recipe kind/runtimeProfile are required");
  registries.recipeKinds.require(raw.kind);
  const runtime = registries.runtimeProfiles.require(raw.runtimeProfile);
  if (!Array.isArray(raw.inputs)) throw new Error("Recipe.inputs must be an array");
  const inputs: RecipeInputDefinitionV1[] = raw.inputs.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Recipe.inputs[${index}] must be an object`);
    const input = item as Record<string, unknown>; exact(input, ["path", "role", "type"], `Recipe.inputs[${index}]`);
    if (typeof input.role !== "string" || !input.role || !["file", "directory"].includes(String(input.type))) throw new Error(`invalid Recipe input at ${index}`);
    return { path: relativePath(input.path, `Recipe.inputs[${index}].path`), role: input.role, type: input.type as "file" | "directory" };
  });
  if (new Set(inputs.map((item) => item.path)).size !== inputs.length) throw new Error("Recipe.inputs contains duplicate paths");
  if (!raw.actions || typeof raw.actions !== "object" || Array.isArray(raw.actions)) throw new Error("Recipe.actions must be an object");
  const actions: Record<string, RecipeProgramV1> = {};
  for (const [name, value] of Object.entries(raw.actions as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ID.test(name)) throw new Error(`invalid Recipe action: ${name}`);
    actions[name] = program(value, `Recipe.actions.${name}`);
  }
  if (!Object.keys(actions).length) throw new Error("Recipe requires at least one named action");
  if (!raw.exports || typeof raw.exports !== "object" || Array.isArray(raw.exports)) throw new Error("Recipe.exports must be an object");
  const exports: Record<string, RecipeExportDefinitionV1> = {};
  for (const [name, value] of Object.entries(raw.exports as Record<string, unknown>)) {
    if (!ID.test(name) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid Recipe export: ${name}`);
    const item = value as Record<string, unknown>; exact(item, ["type", "primary", "unit"], `Recipe.exports.${name}`);
    if (!["image", "scalar", "timeseries", "table", "field", "artifact"].includes(String(item.type)) || typeof item.primary !== "boolean" || (item.unit !== undefined && typeof item.unit !== "string")) throw new Error(`invalid Recipe export declaration: ${name}`);
    exports[name] = { type: item.type as RecipeExportDefinitionV1["type"], primary: item.primary, ...(item.unit ? { unit: item.unit as string } : {}) };
  }
  if (!Object.values(exports).some((item) => item.primary)) throw new Error("Recipe requires at least one primary export");
  if (!raw.resources || typeof raw.resources !== "object" || Array.isArray(raw.resources)) throw new Error("Recipe.resources must be an object");
  const resources = raw.resources as Record<string, unknown>; exact(resources, ["cpu", "memoryGiB", "workspaceGiB"], "Recipe.resources");
  for (const key of ["cpu", "memoryGiB", "workspaceGiB"]) if (typeof resources[key] !== "number" || Number(resources[key]) <= 0) throw new Error(`Recipe.resources.${key} must be positive`);
  const limits = (runtime.contract.semantics as Record<string, any>).limits as Record<string, number> | undefined;
  if (limits && (Number(resources.cpu) > limits.cpu || Number(resources.memoryGiB) > limits.memoryGiB || Number(resources.workspaceGiB) > limits.workspaceGiB)) throw new Error("Recipe resource request exceeds runtime profile limits");
  const observer = program(raw.observer, "Recipe.observer");
  const reserved = [...Object.values(actions).flatMap((item) => item.files), ...observer.files].filter((path) => pathsOverlap(path, "pi-recipe.yaml"));
  if (reserved.length) throw new Error(`Recipe program closure overlaps its manifest: ${reserved.join(", ")}`);
  const actionFiles = Object.values(actions).flatMap((item) => item.files);
  const overlap = observer.files.filter((path) => actionFiles.some((actionPath) => pathsOverlap(path, actionPath)));
  if (overlap.length) throw new Error(`Recipe observer files overlap compute closure: ${overlap.join(", ")}`);
  return {
    schema: 1, id: raw.id, version: raw.version, kind: raw.kind, runtimeProfile: raw.runtimeProfile,
    inputs, actions, observer, exports,
    resources: { cpu: Number(resources.cpu), memoryGiB: Number(resources.memoryGiB), workspaceGiB: Number(resources.workspaceGiB) },
  };
}

export async function hashRecipePath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (!inside(canonicalRoot, canonical)) throw new Error(`Recipe closure symlink escapes root: ${path}`);
  const hash = createHash("sha256");
  const visit = async (absolute: string): Promise<void> => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Recipe closure contains a symlink: ${absolute}`);
    const name = relative(canonical, absolute).split(sep).join("/") || ".";
    if (info.isDirectory()) {
      hash.update(`d\0${name}\0`);
      for (const entry of (await readdir(absolute)).sort()) await visit(join(absolute, entry));
    } else if (info.isFile()) {
      hash.update(`f\0${name}\0${info.size}\0`);
      hash.update(await readFile(absolute));
    } else throw new Error(`unsupported Recipe closure entry: ${absolute}`);
  };
  await visit(canonical);
  return hash.digest("hex");
}

export async function hashRecipeProgram(recipeRoot: string, program: RecipeProgramV1, definition: RecipeDefinitionV1, kind: "action" | "observer", name?: string): Promise<string> {
  const files = [];
  for (const path of program.files) files.push({ path, sha256: await hashRecipePath(recipeRoot, resolve(recipeRoot, path)) });
  return canonicalDigest({ kind, ...(name ? { name } : {}), argv: program.argv, timeoutSeconds: program.timeoutSeconds, files, ...(kind === "action" ? { resources: definition.resources } : { exports: definition.exports }) });
}

export async function loadRecipe(cwd: string, recipePath: string, registries: RegistrySet): Promise<LoadedRecipeV1> {
  if (isAbsolute(recipePath) || recipePath.split(/[\\/]+/).includes("..")) throw new Error("Recipe path must be project-relative");
  const projectRoot = await realpath(cwd);
  const recipeRoot = await realpath(resolve(projectRoot, recipePath));
  if (!inside(projectRoot, recipeRoot)) throw new Error("Recipe path escapes project root");
  const manifestPath = resolve(recipeRoot, "pi-recipe.yaml");
  const manifestCanonical = await realpath(manifestPath);
  if (!inside(recipeRoot, manifestCanonical) || (await lstat(manifestPath)).isSymbolicLink()) throw new Error("Recipe manifest symlink escapes its immutable root");
  const definition = compileRecipeDefinition(parseYamlDocument(await readFile(manifestPath, "utf-8"), "pi-recipe.yaml"), registries);
  const inputs = [];
  for (const item of definition.inputs) {
    const absolutePath = await realpath(resolve(projectRoot, item.path));
    if (!inside(projectRoot, absolutePath)) throw new Error(`Recipe input escapes project root: ${item.path}`);
    const info = await lstat(absolutePath);
    if ((item.type === "file") !== info.isFile() || (item.type === "directory") !== info.isDirectory()) throw new Error(`Recipe input type mismatch: ${item.path}`);
    inputs.push({ ...item, absolutePath, projectPath: relative(projectRoot, absolutePath).split(sep).join("/"), sha256: await hashRecipePath(projectRoot, absolutePath) });
  }
  const actionHashes: Record<string, string> = {};
  for (const [name, action] of Object.entries(definition.actions)) actionHashes[name] = await hashRecipeProgram(recipeRoot, action, definition, "action", name);
  return {
    projectRoot, recipeRoot, recipePath: relative(projectRoot, recipeRoot).split(sep).join("/"), manifestPath, definition,
    actionHashes,
    observerHash: await hashRecipeProgram(recipeRoot, definition.observer, definition, "observer"),
    inputs,
  };
}
