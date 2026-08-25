import { readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { RegistrySet } from "../registry.ts";
import { compileWorkflowDefinition } from "./compiler.ts";
import { parseYamlDocument } from "./loader.ts";
import type { WorkflowSnapshotV1 } from "./types.ts";

export interface WorkflowPackageMetadata {
  id: string;
  description: string;
  tags: string[];
  version: string;
}

export interface InstalledWorkflowPackage extends WorkflowPackageMetadata {
  source: string;
  workflow: WorkflowSnapshotV1;
}

const BUILTIN_PACKAGES = fileURLToPath(new URL("../../../workflow-packages", import.meta.url));

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${where} must be a non-empty string array`);
  if (new Set(value).size !== value.length) throw new Error(`${where} contains duplicates`);
  return [...value].sort();
}

function parsePackage(value: unknown, source: string, registries: RegistrySet): InstalledWorkflowPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must contain a workflow package object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !["schema", "id", "description", "tags", "version", "workflow"].includes(key));
  if (raw.schema !== 1 || unknown.length) throw new Error(`${source} has an invalid workflow package schema${unknown.length ? `: ${unknown.join(", ")}` : ""}`);
  for (const key of ["id", "description", "version"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) throw new Error(`${source}.${key} is required`);
  }
  const workflow = compileWorkflowDefinition(raw.workflow, registries);
  if (workflow.id !== raw.id || workflow.version !== raw.version) throw new Error(`${source} package identity does not match its compiled workflow`);
  return {
    id: raw.id as string,
    description: (raw.description as string).trim(),
    tags: strings(raw.tags, `${source}.tags`),
    version: raw.version as string,
    source,
    workflow,
  };
}

async function yamlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const canonicalRoot = await realpath(root);
  const files: string[] = [];
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(resolve(canonicalRoot, entry.name));
    if (!entry.isDirectory()) continue;
    const directory = await realpath(resolve(canonicalRoot, entry.name));
    if (!inside(canonicalRoot, directory)) throw new Error(`workflow package directory escapes discovery root: ${entry.name}`);
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.isFile() && /\.ya?ml$/i.test(child.name)) files.push(resolve(directory, child.name));
    }
  }
  return files.sort();
}

function semverDescending(a: string, b: string): number {
  const parts = (value: string) => value.split(/[.-]/).map((item) => /^\d+$/.test(item) ? Number(item) : item);
  const left = parts(a); const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? 0; const y = right[index] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return y - x;
    return String(y).localeCompare(String(x));
  }
  return 0;
}

/** Discover built-in and project-authored YAML packages, then select the newest installed version per ID. */
export async function discoverWorkflowPackages(cwd: string, registries: RegistrySet): Promise<InstalledWorkflowPackage[]> {
  const roots = [BUILTIN_PACKAGES, resolve(cwd, "workflows")];
  const packages: InstalledWorkflowPackage[] = [];
  const identities = new Set<string>();
  for (const root of roots) {
    for (const path of await yamlFiles(root)) {
      const item = parsePackage(parseYamlDocument(await readFile(path, "utf-8"), path), path, registries);
      const identity = `${item.id}@${item.version}`;
      if (identities.has(identity)) throw new Error(`duplicate installed workflow package: ${identity}`);
      identities.add(identity);
      packages.push(item);
    }
  }
  const selected = new Map<string, InstalledWorkflowPackage>();
  for (const item of packages.sort((a, b) => a.id.localeCompare(b.id) || semverDescending(a.version, b.version))) {
    if (!selected.has(item.id)) selected.set(item.id, item);
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveWorkflowPackage(cwd: string, id: string, registries: RegistrySet): Promise<InstalledWorkflowPackage> {
  const item = (await discoverWorkflowPackages(cwd, registries)).find((candidate) => candidate.id === id);
  if (!item) throw new Error(`workflow package is not installed: ${id}`);
  return item;
}
