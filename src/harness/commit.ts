import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalDigest, canonicalJson, jsonValue, type JsonValue } from "./canonical.ts";
import { commitRecordRef } from "./reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "./run-store.ts";
import type { RegistrySet } from "./registry.ts";

export interface EncodedVariable {
  codec: string;
  value: JsonValue;
  sha256: string;
  metadata?: JsonValue;
}

export interface WorkspaceCommitManifestV1 {
  schema: 1;
  id: string;
  name: string;
  parent: string | null;
  workflowHash: string;
  phase: string;
  variables: Record<string, { codec: string; sha256: string; path: string; metadata?: JsonValue }>;
  artifacts: Array<{ path: string; sha256: string; role: string }>;
  producer: { transport: "json-cli"; session?: string };
  createdAt: string;
}

interface CommitIndexV1 { schema: 1; commits: string[]; }

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(trimmed)) throw new Error("commit name must be a compact process label");
  return trimmed;
}

async function hashArtifact(cwd: string, requested: string, role?: string) {
  if (!requested || isAbsolute(requested) || /^[a-zA-Z]:[\\/]/.test(requested) || requested.split(/[\\/]+/).includes("..")) throw new Error(`artifact path must be project-relative Linux/WSL syntax: ${requested}`);
  const root = await realpath(cwd);
  const path = await realpath(resolve(root, requested));
  if (!inside(root, path)) throw new Error(`artifact escapes project root: ${requested}`);
  const content = await readFile(path);
  return { path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(content), role: role?.trim() || "workspace-commit-artifact" };
}

function normalizeEncodedVariable(name: string, value: EncodedVariable): EncodedVariable {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error(`invalid variable name: ${name}`);
  if (!value || typeof value !== "object" || typeof value.codec !== "string" || !value.codec) throw new Error(`variable ${name} lacks an explicit snapshot codec`);
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error(`variable ${name} lacks a stable snapshot hash`);
  const normalizedValue = jsonValue(value.value);
  const normalizedMetadata = value.metadata === undefined ? undefined : jsonValue(value.metadata);
  const canonical = canonicalJson({ codec: value.codec, value: normalizedValue, ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }) });
  // The Node boundary owns the persisted content hash. JSON number spelling is
  // not stable across runtimes (for example Python emits 0.0 while
  // JSON.parse/JSON.stringify normalizes it to 0), so a client hash is only a
  // transport preflight and must never reject semantically identical content.
  return {
    codec: value.codec,
    value: normalizedValue,
    sha256: sha256(canonical),
    ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }),
  };
}

export async function commitWorkspace(input: {
  cwd: string;
  registries: RegistrySet;
  name: string;
  parent?: string | null;
  variables?: Record<string, EncodedVariable>;
  artifacts?: Array<string | { path: string; role?: string }>;
  session?: string;
}): Promise<WorkspaceCommitManifestV1> {
  const name = safeName(input.name);
  const project = new HarnessProjectStoreV7(input.cwd);
  const active = await project.currentRun(input.registries);
  if (!active) throw new Error("cad.commit requires an active Pi-CAD v7 run");
  const variables = Object.fromEntries(
    Object.entries(input.variables ?? {}).map(([key, value]) => [key, normalizeEncodedVariable(key, value)]),
  );
  const artifacts = await Promise.all((input.artifacts ?? []).map((item) => typeof item === "string" ? hashArtifact(input.cwd, item) : hashArtifact(input.cwd, item.path, item.role)));
  const run = new HarnessRunStoreV7(input.cwd, active.state.runId);
  let result: WorkspaceCommitManifestV1 | null = null;
  await run.mutate(input.registries, async (loaded) => {
    const index = await run.transactions.readJson<CommitIndexV1>("workspace/commits/index.json") ?? { schema: 1, commits: [] };
    const parent = input.parent === undefined ? (index.commits.at(-1) ?? null) : input.parent;
    if (parent !== null && !index.commits.includes(parent)) throw new Error(`workspace commit parent not found: ${parent}`);
    const variableRefs: WorkspaceCommitManifestV1["variables"] = {};
    const payloads: Record<string, string | Buffer | JsonValue> = {};
    for (const [key, encoded] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
      const path = `workspace/snapshots/${encoded.sha256}.json`;
      variableRefs[key] = { codec: encoded.codec, sha256: encoded.sha256, path, ...(encoded.metadata === undefined ? {} : { metadata: encoded.metadata }) };
      payloads[path] = { schema: 1, codec: encoded.codec, value: encoded.value, ...(encoded.metadata === undefined ? {} : { metadata: encoded.metadata }) };
    }
    const identity = { schema: 1, name, parent, workflowHash: loaded.workflow.hash, phase: loaded.state.phase, variables: variableRefs, artifacts };
    const id = `commit-${canonicalDigest(identity).slice(0, 32)}`;
    if (index.commits.includes(id)) {
      const existing = await run.transactions.readJson<WorkspaceCommitManifestV1>(`workspace/commits/${id}.json`);
      if (!existing) throw new Error(`workspace commit index is corrupt: ${id}`);
      result = existing;
      return { state: loaded.state, event: { type: "WorkspaceCommitReused", data: { id, name } } };
    }
    const manifest: WorkspaceCommitManifestV1 = {
      ...identity, id, producer: { transport: "json-cli", ...(input.session ? { session: input.session } : {}) }, createdAt: new Date().toISOString(),
    };
    const manifestPath = `workspace/commits/${id}.json`;
    payloads[manifestPath] = jsonValue(manifest);
    payloads["workspace/commits/index.json"] = { schema: 1, commits: [...index.commits, id] };
    let state = loaded.state;
    const expected = loaded.workflow.phases[state.phase]!.recordObligations.find((item) => item.ref === name && item.type === "workspace_commit" && item.closeWith === "cad_commit");
    if (expected) {
      state = commitRecordRef(state, loaded.workflow, {
        obligationRef: expected.ref, type: "workspace_commit", path: manifestPath,
        sha256: sha256(canonicalJson(manifest)), workflowHash: loaded.workflow.hash, createdAt: manifest.createdAt,
      });
    }
    result = manifest;
    return { state, payloads, event: { type: "WorkspaceCommitted", data: { id, name, parent, artifactCount: artifacts.length, variableCount: Object.keys(variables).length } } };
  });
  if (!result) throw new Error("workspace commit did not produce a manifest");
  return result;
}

async function activeRun(cwd: string, registries: RegistrySet) {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(registries);
  if (!loaded) throw new Error("no active Pi-CAD v7 run");
  return { loaded, store: new HarnessRunStoreV7(cwd, loaded.state.runId) };
}

export async function loadWorkspaceCommit(cwd: string, registries: RegistrySet, id: string): Promise<{ manifest: WorkspaceCommitManifestV1; variables: Record<string, JsonValue> }> {
  if (!/^commit-[a-f0-9]{32}$/.test(id)) throw new Error(`invalid workspace commit ID: ${id}`);
  const { store } = await activeRun(cwd, registries);
  const manifest = await store.transactions.readJson<WorkspaceCommitManifestV1>(`workspace/commits/${id}.json`);
  if (!manifest || manifest.id !== id) throw new Error(`workspace commit not found: ${id}`);
  const variables: Record<string, JsonValue> = {};
  for (const [name, ref] of Object.entries(manifest.variables)) {
    const snapshot = await store.transactions.readJson<{ schema: 1; codec: string; value: JsonValue; metadata?: JsonValue }>(ref.path);
    if (!snapshot || snapshot.codec !== ref.codec) throw new Error(`workspace snapshot missing or incompatible: ${name}`);
    const digest = sha256(canonicalJson({ codec: snapshot.codec, value: snapshot.value, ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }) }));
    if (digest !== ref.sha256) throw new Error(`workspace snapshot hash mismatch: ${name}`);
    variables[name] = jsonValue(snapshot);
  }
  return { manifest, variables };
}

export async function workspaceHistory(cwd: string, registries: RegistrySet): Promise<WorkspaceCommitManifestV1[]> {
  const { store } = await activeRun(cwd, registries);
  const index = await store.transactions.readJson<CommitIndexV1>("workspace/commits/index.json") ?? { schema: 1, commits: [] };
  const values = await Promise.all(index.commits.map((id) => store.transactions.readJson<WorkspaceCommitManifestV1>(`workspace/commits/${id}.json`)));
  if (values.some((value) => !value)) throw new Error("workspace commit history is corrupt");
  return values as WorkspaceCommitManifestV1[];
}
