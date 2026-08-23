import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const SIMULATION_RECIPE_SCHEMA = 1;
export const EXPORT_TYPES = ["image", "scalar", "timeseries", "table", "field", "artifact"] as const;
export type SimulationExportType = (typeof EXPORT_TYPES)[number];
export type QuantitativeExportType = "scalar" | "timeseries" | "table";

export interface ExportDeclaration {
  type: SimulationExportType;
  primary: boolean;
  title?: string;
  unit?: string;
  xUnit?: string;
  yUnit?: string;
  format?: string;
}

export interface SimulationRecipeManifest {
  schema: 1;
  entrypoint: string;
  observe: string;
  nonvisual: boolean;
  inputs: string[];
  observationFiles: string[];
  exports: Record<string, ExportDeclaration>;
}

export interface FrozenInput {
  declaration: string;
  absolutePath: string;
  projectPath: string;
  sha256: string;
  kind: "file" | "directory";
}

export interface LoadedSimulationRecipe {
  projectRoot: string;
  recipeRoot: string;
  recipePath: string;
  manifestPath: string;
  manifest: SimulationRecipeManifest;
  computeRecipeHash: string;
  observationProgramHash: string;
  inputs: FrozenInput[];
}

type TomlScalar = string | number | boolean | string[];

function stripComment(line: string): string {
  let quote = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote && escaped) {
      escaped = false;
      continue;
    }
    if (quote && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') quote = !quote;
    if (!quote && ch === "#") return line.slice(0, i);
  }
  return line;
}

function arrayClosed(value: string): boolean {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (const ch of value) {
    if (quote && escaped) {
      escaped = false;
      continue;
    }
    if (quote && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') quote = !quote;
    if (!quote && ch === "[") depth += 1;
    if (!quote && ch === "]") depth -= 1;
  }
  return depth === 0 && !quote;
}

function parseString(value: string, where: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw new Error(`${where} must be a TOML basic string`);
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new Error(`${where} contains an invalid string escape`);
  }
}

function parseValue(value: string, where: string): TomlScalar {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) throw new Error(`${where} has an unterminated array`);
    const body = trimmed.slice(1, -1);
    const values: string[] = [];
    let start = 0;
    let quote = false;
    let escaped = false;
    for (let i = 0; i <= body.length; i += 1) {
      const ch = body[i];
      if (quote && escaped) {
        escaped = false;
        continue;
      }
      if (quote && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') quote = !quote;
      if ((!quote && ch === ",") || i === body.length) {
        const item = body.slice(start, i).trim();
        if (item) values.push(parseString(item, where));
        start = i + 1;
      }
    }
    if (quote) throw new Error(`${where} has an unterminated string`);
    return values;
  }
  if (trimmed.startsWith('"')) return parseString(trimmed, where);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
  throw new Error(`${where} uses an unsupported TOML value`);
}

/** Strict parser for the deliberately small pi-sim.toml schema. */
export function parseSimulationManifest(text: string): SimulationRecipeManifest {
  const top = new Map<string, TomlScalar>();
  const exports = new Map<string, Map<string, TomlScalar>>();
  let section: { kind: "top" } | { kind: "export"; name: string } = { kind: "top" };
  const rawLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    let line = stripComment(rawLines[index]).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const match = line.match(/^\[exports\.([A-Za-z0-9_.-]+)\]$/);
      if (!match) throw new Error(`pi-sim.toml:${index + 1}: unsupported table ${line}`);
      if (exports.has(match[1])) throw new Error(`duplicate export declaration: ${match[1]}`);
      exports.set(match[1], new Map());
      section = { kind: "export", name: match[1] };
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`pi-sim.toml:${index + 1}: expected key = value`);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`pi-sim.toml:${index + 1}: invalid key ${key}`);
    }
    let rawValue = line.slice(eq + 1).trim();
    while (rawValue.startsWith("[") && !arrayClosed(rawValue)) {
      index += 1;
      if (index >= rawLines.length) throw new Error(`pi-sim.toml: unterminated array for ${key}`);
      rawValue += `\n${stripComment(rawLines[index]).trim()}`;
    }
    const target = section.kind === "top" ? top : exports.get(section.name)!;
    if (target.has(key)) throw new Error(`duplicate key ${key}${section.kind === "export" ? ` in exports.${section.name}` : ""}`);
    target.set(key, parseValue(rawValue, key));
  }

  const allowedTop = new Set(["schema", "entrypoint", "observe", "nonvisual", "inputs", "observation_files"]);
  for (const key of top.keys()) if (!allowedTop.has(key)) throw new Error(`unknown manifest key: ${key}`);
  const allowedExport = new Set(["type", "primary", "title", "unit", "x_unit", "y_unit", "format"]);
  const value = <T extends TomlScalar>(key: string, expected: string): T => {
    if (!top.has(key)) throw new Error(`missing manifest key: ${key}`);
    const found = top.get(key)!;
    if (expected === "string" && typeof found !== "string") throw new Error(`${key} must be a string`);
    if (expected === "boolean" && typeof found !== "boolean") throw new Error(`${key} must be a boolean`);
    if (expected === "number" && typeof found !== "number") throw new Error(`${key} must be a number`);
    if (expected === "array" && !Array.isArray(found)) throw new Error(`${key} must be a string array`);
    return found as T;
  };
  const schema = value<number>("schema", "number");
  if (schema !== SIMULATION_RECIPE_SCHEMA) throw new Error(`unsupported pi-sim schema: ${schema}`);
  const entrypoint = value<string>("entrypoint", "string").trim();
  const observe = value<string>("observe", "string").trim();
  const nonvisual = value<boolean>("nonvisual", "boolean");
  const inputs = value<string[]>("inputs", "array");
  const observationFiles = value<string[]>("observation_files", "array");
  if (!entrypoint || /[\0\r\n]/.test(entrypoint)) throw new Error("entrypoint must be a non-empty single-line command");
  if (!observe || /[\0\r\n]/.test(observe)) throw new Error("observe must be a non-empty single-line command");
  if (observationFiles.length === 0) throw new Error("observation_files must declare at least one file or directory");
  if (new Set(inputs).size !== inputs.length) throw new Error("inputs contains duplicate declarations");
  if (new Set(observationFiles).size !== observationFiles.length) throw new Error("observation_files contains duplicate declarations");

  const declarations: Record<string, ExportDeclaration> = {};
  for (const [name, table] of exports) {
    for (const key of table.keys()) if (!allowedExport.has(key)) throw new Error(`unknown key exports.${name}.${key}`);
    const type = table.get("type");
    if (typeof type !== "string" || !(EXPORT_TYPES as readonly string[]).includes(type)) {
      throw new Error(`exports.${name}.type must be one of ${EXPORT_TYPES.join(", ")}`);
    }
    const primary = table.get("primary") ?? false;
    if (typeof primary !== "boolean") throw new Error(`exports.${name}.primary must be boolean`);
    const stringField = (key: string): string | undefined => {
      const field = table.get(key);
      if (field === undefined) return undefined;
      if (typeof field !== "string" || field.trim() === "") throw new Error(`exports.${name}.${key} must be a non-empty string`);
      return field;
    };
    declarations[name] = {
      type: type as SimulationExportType,
      primary,
      ...(stringField("title") ? { title: stringField("title") } : {}),
      ...(stringField("unit") ? { unit: stringField("unit") } : {}),
      ...(stringField("x_unit") ? { xUnit: stringField("x_unit") } : {}),
      ...(stringField("y_unit") ? { yUnit: stringField("y_unit") } : {}),
      ...(stringField("format") ? { format: stringField("format") } : {}),
    };
  }
  const primary = Object.values(declarations).filter((item) => item.primary);
  const quantitative = (item: ExportDeclaration): item is ExportDeclaration & { type: QuantitativeExportType } =>
    item.type === "scalar" || item.type === "timeseries" || item.type === "table";
  if (nonvisual) {
    if (!primary.some(quantitative)) throw new Error("nonvisual recipe requires a primary quantitative export");
  } else {
    if (!primary.some((item) => item.type === "image")) throw new Error("visual recipe requires a primary image export");
    if (!primary.some(quantitative)) throw new Error("visual recipe requires a primary quantitative export");
  }
  return {
    schema: 1,
    entrypoint,
    observe,
    nonvisual,
    inputs,
    observationFiles,
    exports: declarations,
  };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalExisting(path: string, where: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new Error(`${where} does not exist: ${path}`);
  }
}

interface HashTreeOptions {
  allowedRoots: string[];
  exclude?: (absolutePath: string) => boolean;
}

async function hashTree(root: string, options: HashTreeOptions): Promise<{ hash: string; kind: "file" | "directory" }> {
  const hash = createHash("sha256");
  const activeTargets = new Set<string>();
  const visit = async (path: string, logical: string): Promise<void> => {
    if (options.exclude?.(path)) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const link = await readlink(path);
      const target = await canonicalExisting(resolve(path, "..", link), `symlink target for ${logical}`);
      if (!options.allowedRoots.some((allowed) => inside(allowed, target))) {
        throw new Error(`symlink escapes declared recipe/input closure: ${logical} -> ${link}`);
      }
      hash.update(`L\0${logical}\0${link}\0`);
      if (activeTargets.has(target)) throw new Error(`symlink cycle in declared recipe/input closure: ${logical}`);
      activeTargets.add(target);
      await visit(target, `${logical}@target`);
      activeTargets.delete(target);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${logical}\0`);
      const names = (await readdir(path)).sort();
      for (const name of names) await visit(resolve(path, name), logical ? `${logical}/${name}` : name);
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported filesystem entry in recipe/input: ${logical}`);
    hash.update(`F\0${logical}\0${stat.mode & 0o777}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  };
  const rootStat = await stat(root);
  await visit(root, "");
  return { hash: hash.digest("hex"), kind: rootStat.isDirectory() ? "directory" : "file" };
}

/** Recompute the same content identity used for declared Recipe inputs. */
export async function hashSimulationPath(path: string, closureRoot: string): Promise<{ hash: string; kind: "file" | "directory" }> {
  const existing = await canonicalExisting(path, "simulation provenance input");
  const closure = await canonicalExisting(closureRoot, "simulation provenance closure");
  if (!inside(closure, existing)) throw new Error(`simulation provenance input escapes project root: ${path}`);
  return hashTree(path, { allowedRoots: [closure] });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function selectSimulationOutputs(manifest: SimulationRecipeManifest, outputs?: string[]): string[] {
  if (outputs && outputs.length === 0) throw new Error("outputs=[] is invalid; omit outputs to request primary exports");
  if ((outputs?.length ?? 0) > 16) throw new Error("at most 16 additional outputs may be requested");
  const requested = outputs ?? [];
  for (const name of requested) if (!(name in manifest.exports)) throw new Error(`unknown recipe output: ${name}`);
  const primary = Object.entries(manifest.exports).filter(([, declaration]) => declaration.primary).map(([name]) => name);
  return [...new Set([...primary, ...requested])];
}

export async function loadSimulationRecipe(projectRoot: string, recipe: string): Promise<LoadedSimulationRecipe> {
  const root = resolve(projectRoot);
  const recipeRoot = resolve(root, recipe);
  if (!inside(root, recipeRoot)) throw new Error("recipe path escapes project root");
  const recipeReal = await canonicalExisting(recipeRoot, "recipe");
  const projectReal = await canonicalExisting(root, "project root");
  if (!inside(projectReal, recipeReal)) throw new Error("recipe symlink escapes project root");
  const manifestPath = resolve(recipeReal, "pi-sim.toml");
  const manifest = parseSimulationManifest(await readFile(manifestPath, "utf-8"));
  const inputPaths = await Promise.all(manifest.inputs.map(async (declaration) => {
    const absolutePath = resolve(recipeReal, declaration);
    if (!inside(projectReal, absolutePath)) throw new Error(`declared input escapes project root: ${declaration}`);
    const real = await canonicalExisting(absolutePath, `declared input ${declaration}`);
    if (!inside(projectReal, real)) throw new Error(`declared input symlink escapes project root: ${declaration}`);
    return { declaration, absolutePath, real };
  }));
  const allowedRoots = [recipeReal, ...inputPaths.map((item) => item.real)];
  const observationRoots = await Promise.all(manifest.observationFiles.map(async (declaration) => {
    const path = resolve(recipeReal, declaration);
    if (!inside(recipeReal, path)) throw new Error(`observation_files path escapes recipe: ${declaration}`);
    const real = await canonicalExisting(path, `observation_files entry ${declaration}`);
    if (!inside(recipeReal, real)) throw new Error(`observation_files symlink escapes recipe: ${declaration}`);
    return real;
  }));
  const isObservation = (path: string) => observationRoots.some((entry) => inside(entry, path));
  const computeTree = await hashTree(recipeReal, {
    allowedRoots,
    exclude: (path) => path === manifestPath || isObservation(path),
  });
  const computeProjection = {
    schema: manifest.schema,
    entrypoint: manifest.entrypoint,
    inputs: manifest.inputs,
    observationFiles: manifest.observationFiles,
  };
  const computeRecipeHash = createHash("sha256").update(stable(computeProjection)).update(computeTree.hash).digest("hex");
  const observationHash = createHash("sha256").update(stable({ observe: manifest.observe, nonvisual: manifest.nonvisual, exports: manifest.exports }));
  for (const path of observationRoots.sort()) observationHash.update((await hashTree(path, { allowedRoots })).hash);
  const inputs: FrozenInput[] = [];
  for (const item of inputPaths) {
    const tree = await hashTree(item.absolutePath, { allowedRoots });
    inputs.push({
      declaration: item.declaration,
      absolutePath: item.absolutePath,
      projectPath: relative(projectReal, item.absolutePath).split(sep).join("/"),
      sha256: tree.hash,
      kind: tree.kind,
    });
  }
  return {
    projectRoot: projectReal,
    recipeRoot: recipeReal,
    recipePath: relative(projectReal, recipeReal).split(sep).join("/"),
    manifestPath,
    manifest,
    computeRecipeHash,
    observationProgramHash: observationHash.digest("hex"),
    inputs,
  };
}
