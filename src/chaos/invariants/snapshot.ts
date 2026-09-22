import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { JsonValue } from "../../harness/canonical.ts";
import { canonicalDigest } from "../../harness/canonical.ts";
import type { WorkspaceCommitManifestV1 } from "../../harness/commit.ts";
import { defaultCanonicalProjectDirectory, harnessStorageRoot } from "../../authority/storage.ts";
import type { HarnessProjectStateV7 } from "../../harness/run-store.ts";
import type { HarnessRunStateV7, EvidenceRefV7, RecordRefV7 } from "../../harness/state.ts";
import type { StatusProjectionV1 } from "../../authority/storage.ts";
import type {
  FileIdentityObservation,
  LockObservation,
  RecipeRunObservation,
  ReifyProjectSnapshot,
  ReifyRunSnapshot,
  StagingObservation,
  WorkflowView,
} from "./types.ts";

const RUN_ID_PATTERN = /^v7-/;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonOrNull<T>(path: string): Promise<{ value: T | null; error: string | null; raw: string | null }> {
  const raw = await readTextOrNull(path);
  if (raw === null) return { value: null, error: null, raw: null };
  try {
    return { value: JSON.parse(raw) as T, error: null, raw };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error), raw };
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function hashOrNull(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export function pidAlive(pid: number | null): boolean | null {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
}

/** Read a real transaction lock, including whether its owner process still exists. */
async function readLock(path: string, now: number): Promise<LockObservation | null> {
  const info = await statOrNull(path);
  if (!info) return null;
  const { value } = await readJsonOrNull<{ pid?: unknown; createdAt?: unknown }>(path);
  const pid = typeof value?.pid === "number" ? value.pid : null;
  return {
    path,
    pid,
    ownerAlive: pidAlive(pid),
    createdAt: typeof value?.createdAt === "string" ? value.createdAt : null,
    ageMs: Math.max(0, now - info.mtimeMs),
  };
}

/**
 * A recipe prepare writes `recipe-runs/<id>.staging-<pid>` and renames it on
 * success. A leftover staging directory means the preparing process died.
 */
async function readStagingDirectories(directory: string, now: number): Promise<StagingObservation[]> {
  const observations: StagingObservation[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return observations;
  }
  for (const name of names) {
    const match = /\.staging-(\d+)$/.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    const info = await statOrNull(path);
    const pid = Number(match[1]);
    observations.push({ path, pid, ownerAlive: pidAlive(pid), ageMs: Math.max(0, now - (info?.mtimeMs ?? now)) });
  }
  return observations;
}

async function readRecipeRuns(runDirectory: string, now: number): Promise<RecipeRunObservation[]> {
  const root = join(runDirectory, "recipe-runs");
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => !name.includes(".staging-"));
  } catch {
    return [];
  }
  const staging = await readStagingDirectories(root, now);
  const observations: RecipeRunObservation[] = [];
  for (const name of names) {
    const directory = join(root, name);
    const { value: record } = await readJsonOrNull<{ status?: unknown; workflowRunId?: unknown; createdAt?: unknown; completedAt?: unknown }>(
      join(directory, "record", "run.json"),
    );
    if (!record) continue;
    const { value: head } = await readJsonOrNull<{ generation?: unknown }>(join(directory, "record", "HEAD"));
    const info = await statOrNull(join(directory, "record", "run.json"));
    const idleMs = Math.max(0, now - (info?.mtimeMs ?? now));
    observations.push({
      workflowRunId: typeof record.workflowRunId === "string" ? record.workflowRunId : "",
      recipeRunId: name,
      status: typeof record.status === "string" ? record.status : "unknown",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      completedAt: typeof record.completedAt === "string" ? record.completedAt : null,
      generation: typeof head?.generation === "number" ? head.generation : null,
      idleMs,
      hasStaging: staging.some((item) => item.path.startsWith(`${directory}.staging`) || item.path === `${directory}.staging`),
    });
  }
  return observations.sort((a, b) => a.recipeRunId.localeCompare(b.recipeRunId));
}

interface HeadPointer {
  schema?: unknown;
  generation?: unknown;
  txId?: unknown;
  commitHash?: unknown;
}

/**
 * Verify the published generation: commit hash, manifest hash, identity, and
 * every payload byte. Then walk parent links back to generation zero so a
 * half-published or rewritten generation is caught, not just the HEAD file.
 */
async function verifyTransactionChain(directory: string, head: HeadPointer | null, maxSteps = 10_000): Promise<string[]> {
  const errors: string[] = [];
  let txId = typeof head?.txId === "string" ? head.txId : null;
  let expectedGeneration = typeof head?.generation === "number" ? head.generation : null;
  let expectedCommitHash = typeof head?.commitHash === "string" ? head.commitHash : null;
  if (!txId || expectedGeneration === null || !expectedCommitHash) return errors;
  let steps = 0;
  while (txId && expectedGeneration !== 0 && steps < maxSteps) {
    steps += 1;
    const transactionDirectory = join(directory, "transactions", txId);
    const commitRaw = await readTextOrNull(join(transactionDirectory, "commit.json"));
    if (commitRaw === null) {
      errors.push(`transaction ${txId} has no commit.json`);
      break;
    }
    if (sha256(commitRaw) !== expectedCommitHash) {
      errors.push(`transaction ${txId} commit hash does not match its parent pointer`);
      break;
    }
    let commit: { txId?: unknown; nextGeneration?: unknown; manifestHash?: unknown };
    try {
      commit = JSON.parse(commitRaw) as typeof commit;
    } catch (error) {
      errors.push(`transaction ${txId} commit.json is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (commit.txId !== txId) errors.push(`transaction ${txId} commit names ${String(commit.txId)}`);
    if (commit.nextGeneration !== expectedGeneration) errors.push(`transaction ${txId} publishes generation ${String(commit.nextGeneration)}, expected ${expectedGeneration}`);
    const manifestRaw = await readTextOrNull(join(transactionDirectory, "manifest.json"));
    if (manifestRaw === null) {
      errors.push(`transaction ${txId} has no manifest.json`);
      break;
    }
    if (sha256(manifestRaw) !== commit.manifestHash) errors.push(`transaction ${txId} manifest hash does not match commit.json`);
    let manifest: { txId?: unknown; parentTxId?: unknown; parentGeneration?: unknown; parentCommitHash?: unknown; files?: unknown };
    try {
      manifest = JSON.parse(manifestRaw) as typeof manifest;
    } catch (error) {
      errors.push(`transaction ${txId} manifest.json is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (manifest.txId !== txId) errors.push(`transaction ${txId} manifest names ${String(manifest.txId)}`);
    const files = Array.isArray(manifest.files) ? manifest.files as Array<{ path?: unknown; size?: unknown; sha256?: unknown }> : [];
    for (const descriptor of files) {
      if (typeof descriptor.path !== "string") {
        errors.push(`transaction ${txId} manifest has a descriptor without a path`);
        continue;
      }
      const content = await readTextOrNull(join(transactionDirectory, descriptor.path));
      if (content === null) {
        errors.push(`transaction ${txId} payload is missing: ${descriptor.path}`);
        continue;
      }
      if (sha256(content) !== descriptor.sha256) errors.push(`transaction ${txId} payload hash mismatch: ${descriptor.path}`);
    }
    txId = typeof manifest.parentTxId === "string" ? manifest.parentTxId : null;
    expectedGeneration = typeof manifest.parentGeneration === "number" ? manifest.parentGeneration : null;
    expectedCommitHash = typeof manifest.parentCommitHash === "string" ? manifest.parentCommitHash : null;
  }
  if (steps >= maxSteps) errors.push("transaction ancestry did not terminate within the walk budget");
  else if (txId === null && expectedGeneration !== null && expectedGeneration !== 0) errors.push(`transaction ancestry stopped at generation ${expectedGeneration}`);
  return errors;
}

async function readHead(directory: string): Promise<{ head: HeadPointer | null; error: string | null; generation: number | null }> {
  const { value, error } = await readJsonOrNull<HeadPointer>(join(directory, "HEAD"));
  if (error) return { head: null, error, generation: null };
  if (!value) return { head: null, error: null, generation: null };
  return { head: value, error: null, generation: typeof value.generation === "number" ? value.generation : null };
}

async function readEvents(directory: string): Promise<{ events: Array<{ type: string; data?: JsonValue }>; lineCount: number; error: string | null }> {
  const raw = await readTextOrNull(join(directory, "events.jsonl"));
  if (raw === null) return { events: [], lineCount: 0, error: null };
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  try {
    const events = lines.map((line) => JSON.parse(line) as { type: string; data?: JsonValue });
    return { events, lineCount: lines.length, error: null };
  } catch (error) {
    return { events: [], lineCount: lines.length, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Walk the published transaction ancestry and read the run status each
 * generation committed. This is the only honest source for "did a terminal
 * run ever go back to active": it reads the immutable generations, not the
 * mutable materialized view or an in-memory cache.
 */
async function readStatusTimeline(directory: string, head: HeadPointer | null): Promise<Array<{ generation: number; status: string; phase: string }>> {
  const timeline: Array<{ generation: number; status: string; phase: string }> = [];
  let txId = typeof head?.txId === "string" ? head.txId : null;
  let expectedGeneration = typeof head?.generation === "number" ? head.generation : null;
  const seen = new Set<string>();
  while (txId && expectedGeneration !== null && !seen.has(txId)) {
    seen.add(txId);
    const transactionDirectory = join(directory, "transactions", txId);
    const { value: manifest } = await readJsonOrNull<{ parentTxId?: unknown; parentGeneration?: unknown }>(join(transactionDirectory, "manifest.json"));
    const { value: state } = await readJsonOrNull<{ status?: unknown; phase?: unknown }>(join(transactionDirectory, "state.json"));
    if (state && typeof state.status === "string" && typeof state.phase === "string") {
      timeline.push({ generation: expectedGeneration, status: state.status, phase: state.phase });
    }
    txId = typeof manifest?.parentTxId === "string" ? manifest.parentTxId : null;
    expectedGeneration = typeof manifest?.parentGeneration === "number" ? manifest.parentGeneration : null;
  }
  return timeline.reverse();
}

async function readUnpublishedTransactions(directory: string, now: number): Promise<Array<{ txId: string; ageMs: number }>> {
  let names: string[];
  try {
    names = await readdir(join(directory, "transactions"));
  } catch {
    return [];
  }
  const pending: Array<{ txId: string; ageMs: number }> = [];
  for (const name of names.filter((item) => /^tx-/.test(item))) {
    const transactionDirectory = join(directory, "transactions", name);
    const commit = await statOrNull(join(transactionDirectory, "commit.json"));
    if (commit) continue;
    const info = await statOrNull(transactionDirectory);
    pending.push({ txId: name, ageMs: Math.max(0, now - (info?.mtimeMs ?? now)) });
  }
  return pending;
}

async function observeFile(input: {
  id: string;
  recordedPath: string;
  recordedSha256: string;
  location: "project" | "run-store";
  absolutePath: string;
  rule: "file-bytes" | "canonical-content";
}): Promise<FileIdentityObservation> {
  const bytes = await readFileOrNull(input.absolutePath);
  const observedFileSha256 = bytes === null ? null : sha256(bytes);
  return {
    id: input.id,
    recordedPath: input.recordedPath,
    absolutePath: input.absolutePath,
    recordedSha256: input.recordedSha256,
    observedSha256: observedFileSha256,
    observedFileSha256,
    digestRule: input.rule,
    location: input.location,
  };
}

/**
 * Run-store references use the identity rule of their own producer, not the
 * hash of the file that stores them:
 * - a record is identified by the canonical digest of its stored value;
 * - candidate evidence is identified by the canonical digest of its envelope;
 * - concept-image evidence points at a project file and carries that file's hash.
 */
async function observeRunStoreReference(input: {
  id: string;
  recordedPath: string;
  recordedSha256: string;
  absolutePath: string;
  kind: "evidence" | "record";
  projectRoot: string;
}): Promise<FileIdentityObservation> {
  const bytes = await readFileOrNull(input.absolutePath);
  const observedFileSha256 = bytes === null ? null : sha256(bytes);
  let observedSha256: string | null = null;
  let digestRule: FileIdentityObservation["digestRule"] = "canonical-content";
  let referencedAbsolutePath: string | null = null;
  if (bytes !== null) {
    try {
      const payload = JSON.parse(bytes.toString("utf8")) as { envelope?: unknown; sha256?: unknown; path?: unknown };
      if (input.kind === "evidence" && payload.envelope !== undefined) {
        observedSha256 = canonicalDigest(payload.envelope);
      } else if (
        input.kind === "evidence"
        && typeof payload.sha256 === "string"
        && /^[a-f0-9]{64}$/.test(payload.sha256)
        && typeof payload.path === "string"
      ) {
        digestRule = "referenced-file";
        referencedAbsolutePath = resolve(input.projectRoot, payload.path);
        observedSha256 = await hashOrNull(referencedAbsolutePath);
      } else {
        observedSha256 = canonicalDigest(payload);
      }
    } catch {
      observedSha256 = null;
    }
  }
  return {
    id: input.id,
    recordedPath: input.recordedPath,
    absolutePath: referencedAbsolutePath ?? input.absolutePath,
    recordedSha256: input.recordedSha256,
    observedSha256,
    observedFileSha256,
    digestRule,
    location: "run-store",
  };
}

function runStorePayloadPath(runDirectory: string, head: HeadPointer | null, payloadPath: string): string {
  const txId = typeof head?.txId === "string" ? head.txId : "";
  return join(runDirectory, "transactions", txId, payloadPath);
}

async function readCommits(runDirectory: string): Promise<{ commits: WorkspaceCommitManifestV1[]; index: string[]; errors: string[] }> {
  const errors: string[] = [];
  const { value: index } = await readJsonOrNull<{ commits?: unknown }>(join(runDirectory, "workspace", "commits", "index.json"));
  const ids = Array.isArray(index?.commits) ? (index!.commits as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const commits: WorkspaceCommitManifestV1[] = [];
  for (const id of ids) {
    const { value, error } = await readJsonOrNull<WorkspaceCommitManifestV1>(join(runDirectory, "workspace", "commits", `${id}.json`));
    if (error) errors.push(`${id}: ${error}`);
    else if (!value) errors.push(`${id}: manifest missing`);
    else if (value.id !== id) errors.push(`${id}: manifest id is ${String(value.id)}`);
    else commits.push(value);
  }
  return { commits, index: ids, errors };
}

function workflowView(value: unknown): WorkflowView | null {
  if (!value || typeof value !== "object") return null;
  const workflow = value as { id?: unknown; version?: unknown; hash?: unknown; initialPhase?: unknown; phases?: unknown };
  if (typeof workflow.id !== "string" || typeof workflow.hash !== "string" || !workflow.phases || typeof workflow.phases !== "object") return null;
  const phases: WorkflowView["phases"] = {};
  for (const [phaseId, phaseValue] of Object.entries(workflow.phases as Record<string, unknown>)) {
    const phase = (phaseValue ?? {}) as { recordObligations?: unknown; evidenceObligations?: unknown };
    const list = (items: unknown) => (Array.isArray(items) ? items : [])
      .filter((item): item is { ref: string; type: string; closeWith: string } => Boolean(item) && typeof (item as { ref?: unknown }).ref === "string")
      .map((item) => ({ ref: item.ref, type: String(item.type ?? ""), closeWith: String(item.closeWith ?? "") }));
    phases[phaseId] = { recordObligations: list(phase.recordObligations), evidenceObligations: list(phase.evidenceObligations) };
  }
  return {
    id: workflow.id,
    version: String(workflow.version ?? ""),
    hash: workflow.hash,
    initialPhase: String(workflow.initialPhase ?? ""),
    phases,
  };
}

export async function readReifyRunSnapshot(cwd: string, runId: string, now: number, storageRoot = harnessStorageRoot(cwd)): Promise<ReifyRunSnapshot> {
  const directory = join(storageRoot, "runs", runId);
  const projectRoot = resolve(cwd);

  const materializedPath = join(directory, "state.json");
  const materialized = await readJsonOrNull<HarnessRunStateV7>(materializedPath);
  const materializedStateSha256 = await hashOrNull(materializedPath);

  const { head, error: headError, generation } = await readHead(directory);
  const headStatePath = runStorePayloadPath(directory, head, "state.json");
  const headStateSha256 = typeof head?.txId === "string" ? await hashOrNull(headStatePath) : null;

  const { events, lineCount, error: eventError } = await readEvents(directory);
  const state = materialized.value;
  const stateError = materialized.error;
  const statusTimeline = await readStatusTimeline(directory, head);
  const headInfo = await statOrNull(join(directory, "HEAD"));

  const artifacts: FileIdentityObservation[] = [];
  const evidence: FileIdentityObservation[] = [];
  const records: FileIdentityObservation[] = [];
  if (state) {
    for (const [id, artifact] of Object.entries(state.artifacts)) {
      artifacts.push(await observeFile({
        id,
        recordedPath: artifact.path,
        recordedSha256: artifact.sha256,
        location: "project",
        absolutePath: resolve(projectRoot, artifact.path),
        rule: "file-bytes",
      }));
    }
    for (const item of state.evidence) {
      evidence.push(await observeRunStoreReference({
        id: item.id,
        recordedPath: item.path,
        recordedSha256: item.sha256,
        absolutePath: runStorePayloadPath(directory, head, item.path),
        kind: "evidence",
        projectRoot,
      }));
    }
    for (const [ref, record] of Object.entries(state.records)) {
      records.push(await observeRunStoreReference({
        id: ref,
        recordedPath: record.path,
        recordedSha256: record.sha256,
        absolutePath: runStorePayloadPath(directory, head, record.path),
        kind: "record",
        projectRoot,
      }));
    }
  }

  const { commits, index, errors: commitErrors } = await readCommits(directory);
  const commitSessions = [...new Set(commits.map((commit) => commit.producer?.session).filter((session): session is string => typeof session === "string" && session.length > 0))];
  const recipeRuns = await readRecipeRuns(directory, now);
  const locks = [await readLock(join(directory, ".head.lock"), now)].filter((item): item is LockObservation => item !== null);
  const staging = await readStagingDirectories(join(directory, "recipe-runs"), now);
  const unpublishedTransactions = await readUnpublishedTransactions(directory, now);
  const workflowRaw = await readJsonOrNull<unknown>(runStorePayloadPath(directory, head, "workflow.json"));
  const workflow = workflowView(workflowRaw.value);
  const transactionErrors = headError ? [] : await verifyTransactionChain(directory, head);

  return {
    runId,
    directory,
    materialized: materialized.raw !== null,
    state,
    stateError,
    materializedStateSha256,
    headStateSha256,
    headGeneration: generation,
    headError: headError ?? (typeof head?.txId === "string" ? null : head ? "HEAD is missing txId" : null),
    transactionErrors,
    events,
    eventLineCount: lineCount,
    statusTimeline,
    advanceAgeMs: headInfo ? Math.max(0, now - headInfo.mtimeMs) : null,
    workflow,
    workflowError: workflowRaw.error ?? (workflow ? null : state ? "workflow.json is missing or not a workflow snapshot" : null),
    artifacts,
    evidence,
    records,
    commits,
    commitIndex: index,
    commitSessions,
    commitErrors: [...commitErrors, ...(eventError ? [`events.jsonl: ${eventError}`] : [])],
    recipeRuns,
    locks,
    staging,
    unpublishedTransactions,
    recordRefs: state ? (Object.values(state.records) as RecordRefV7[]) : [],
    evidenceRefs: state ? (state.evidence as EvidenceRefV7[]) : [],
  };
}

/**
 * A project can have more than one store on disk: the canonical data-home
 * directory the Desktop uses, and a workspace-local `.pi-cad` left by a
 * headless or older run. Reading the stale one manufactures fake violations,
 * so the checker names which store it read and prefers the newest, unless the
 * caller pins one.
 */
export async function resolveStorageRoot(cwd: string, explicit?: string): Promise<{
  root: string;
  source: ReifyProjectSnapshot["storageRootSource"];
  candidates: ReifyProjectSnapshot["storageRootCandidates"];
}> {
  const configured = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  if (explicit) return { root: resolve(explicit), source: "explicit", candidates: [] };
  if (configured) return { root: resolve(configured), source: "env", candidates: [{ root: resolve(configured), source: "env", projectUpdatedAt: null, hasState: true }] };
  const candidates: ReifyProjectSnapshot["storageRootCandidates"] = [];
  const collect = async (root: string, source: "canonical" | "workspace") => {
    const projectStatePath = join(root, "v7-project", "state.json");
    if (!existsSync(projectStatePath)) {
      if (source === "workspace") candidates.push({ root, source, projectUpdatedAt: null, hasState: false });
      return;
    }
    const { value } = await readJsonOrNull<{ updatedAt?: unknown }>(projectStatePath);
    candidates.push({ root, source, projectUpdatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null, hasState: true });
  };
  try {
    await collect(defaultCanonicalProjectDirectory(cwd), "canonical");
  } catch {
    /* an unresolvable cwd simply has no canonical store */
  }
  await collect(harnessStorageRoot(cwd), "workspace");
  const withState = candidates.filter((candidate) => candidate.hasState);
  if (withState.length === 0) return { root: harnessStorageRoot(cwd), source: "workspace-default", candidates };
  if (withState.length === 1) return { root: withState[0]!.root, source: "only-candidate", candidates };
  withState.sort((a, b) => String(b.projectUpdatedAt ?? "").localeCompare(String(a.projectUpdatedAt ?? "")));
  return { root: withState[0]!.root, source: "newest-candidate", candidates };
}

export async function readReifyProjectSnapshot(cwd: string, now = Date.now(), options: { storageRoot?: string } = {}): Promise<ReifyProjectSnapshot> {
  const resolved = await resolveStorageRoot(cwd, options.storageRoot);
  const storageRoot = resolved.root;
  const projectDirectory = join(storageRoot, "v7-project");
  const projectStatePath = join(projectDirectory, "state.json");

  const projectState = await readJsonOrNull<HarnessProjectStateV7>(projectStatePath);
  const { head: projectHead, error: projectHeadError, generation: projectHeadGeneration } = await readHead(projectDirectory);
  const projectHeadInfo = await statOrNull(join(projectDirectory, "HEAD"));
  const projectMaterializedStateSha256 = await hashOrNull(projectStatePath);
  const projectHeadStateSha256 = typeof projectHead?.txId === "string"
    ? await hashOrNull(runStorePayloadPath(projectDirectory, projectHead, "state.json"))
    : null;
  const projectEvents = await readEvents(projectDirectory);

  let presentRunIds: string[] = [];
  try {
    presentRunIds = (await readdir(join(storageRoot, "runs"))).filter((name) => RUN_ID_PATTERN.test(name)).sort();
  } catch {
    presentRunIds = [];
  }

  const listedRunIds = (projectState.value?.runs ?? []).map((run) => run.runId);
  const allRunIds = [...new Set([...listedRunIds, ...presentRunIds])].sort();
  const runs: ReifyRunSnapshot[] = [];
  for (const runId of allRunIds) runs.push(await readReifyRunSnapshot(cwd, runId, now, storageRoot));

  const headArtifacts: FileIdentityObservation[] = [];
  for (const [id, artifact] of Object.entries(projectState.value?.head.artifacts ?? {})) {
    headArtifacts.push(await observeFile({
      id,
      recordedPath: artifact.path,
      recordedSha256: artifact.sha256,
      location: "project",
      absolutePath: resolve(cwd, artifact.path),
      rule: "file-bytes",
    }));
  }

  const projectionPath = join(resolve(cwd), ".pi-cad", "status.json");
  const projectionRaw = await readTextOrNull(projectionPath);
  let projection: StatusProjectionV1 | null = null;
  let projectionError: string | null = null;
  if (projectionRaw !== null) {
    try {
      projection = JSON.parse(projectionRaw) as StatusProjectionV1;
    } catch (error) {
      projectionError = error instanceof Error ? error.message : String(error);
    }
  }
  const projectionInfo = await statOrNull(projectionPath);

  const projectLocks = [await readLock(join(projectDirectory, ".head.lock"), now)].filter((item): item is LockObservation => item !== null);
  const projectUnpublished = await readUnpublishedTransactions(projectDirectory, now);
  const projectTransactionErrors = projectHeadError ? [] : await verifyTransactionChain(projectDirectory, projectHead);

  return {
    cwd: resolve(cwd),
    storageRoot,
    storageRootSource: resolved.source,
    storageRootCandidates: resolved.candidates,
    projectDirectory,
    projectState: projectState.value,
    projectStateError: projectState.error,
    projectHeadGeneration,
    projectAdvanceAgeMs: projectHeadInfo ? Math.max(0, now - projectHeadInfo.mtimeMs) : null,
    projectHeadError: projectHeadError ?? (projectHead && typeof projectHead.txId !== "string" ? "HEAD is missing txId" : null),
    projectTransactionErrors,
    projectMaterializedStateSha256,
    projectHeadStateSha256,
    projectEventLineCount: projectEvents.lineCount,
    listedRunIds,
    presentRunIds,
    runs,
    headArtifacts,
    projection,
    projectionPath,
    projectionError,
    projectionAgeMs: projectionInfo ? Math.max(0, now - projectionInfo.mtimeMs) : null,
    projectLocks,
    unpublishedTransactions: projectUnpublished,
    now,
  };
}
