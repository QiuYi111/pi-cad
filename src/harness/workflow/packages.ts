import { readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
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

export interface WorkflowAdoptionsV1 {
  schema: 1;
  globalSafetyPolicyVersion: string;
  adopted: Record<string, { version: string; adoptedBy: string; adoptedAt: string }>;
  history: Array<{ id: string; from?: string; to: string; adoptedBy: string; adoptedAt: string }>;
}

const BUILTIN_PACKAGES = fileURLToPath(new URL("../../../workflow-packages", import.meta.url));
const BUILTIN_MECHANICAL = resolve(BUILTIN_PACKAGES, "mechanical");

export function workflowUserDirectory(): string {
  return resolve(process.env.PI_CAD_WORKFLOW_HOME ?? process.env.HOME ?? homedir(), ".pi-cad", "workflows");
}

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

/** Discover every installed version. Selection is a separate administrator decision. */
export async function discoverInstalledWorkflowPackages(cwd: string, registries: RegistrySet): Promise<InstalledWorkflowPackage[]> {
  void cwd;
  const sources = [resolve(BUILTIN_MECHANICAL, "naked.yaml"), ...await yamlFiles(workflowUserDirectory())];
  const packages: InstalledWorkflowPackage[] = [];
  const identities = new Map<string, number>();
  for (const path of sources) {
    const item = parsePackage(parseYamlDocument(await readFile(path, "utf-8"), path), path, registries);
    const identity = `${item.id}@${item.version}`;
    if (identities.has(identity)) throw new Error(`duplicate installed workflow package: ${identity}`);
    identities.set(identity, packages.length);
    packages.push(item);
  }
  return packages.sort((a, b) => a.id.localeCompare(b.id) || semverDescending(a.version, b.version));
}

export async function readWorkflowAdoptions(cwd: string): Promise<WorkflowAdoptionsV1> {
  void cwd;
  try {
    const value = JSON.parse(await readFile(resolve(workflowUserDirectory(), "..", "workflow-adoptions.json"), "utf-8")) as WorkflowAdoptionsV1;
    if (value.schema !== 1 || !value.adopted || !Array.isArray(value.history) || typeof value.globalSafetyPolicyVersion !== "string") throw new Error("invalid workflow adoption policy");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schema: 1, globalSafetyPolicyVersion: "builtin-current", adopted: {}, history: [] };
  }
}

export async function discoverWorkflowPackages(cwd: string, registries: RegistrySet): Promise<InstalledWorkflowPackage[]> {
  const installed = await discoverInstalledWorkflowPackages(cwd, registries);
  const policy = await readWorkflowAdoptions(cwd);
  const groups = new Map<string, InstalledWorkflowPackage[]>();
  for (const item of installed) groups.set(item.id, [...(groups.get(item.id) ?? []), item]);
  return [...groups.entries()].map(([id, versions]) => {
    const adopted = policy.adopted[id]?.version;
    if (adopted) {
      const selected = versions.find((item) => item.version === adopted);
      if (!selected) throw new Error(`adopted workflow package is not installed: ${id}@${adopted}`);
      return selected;
    }
    if (versions.length !== 1) throw new Error(`multiple versions installed for ${id}; administrator adoption is required`);
    return versions[0]!;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveWorkflowPackage(cwd: string, id: string, registries: RegistrySet): Promise<InstalledWorkflowPackage> {
  const item = (await discoverWorkflowPackages(cwd, registries)).find((candidate) => candidate.id === id);
  if (!item) throw new Error(`workflow package is not installed: ${id}`);
  return item;
}
