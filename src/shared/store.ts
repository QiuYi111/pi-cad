import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  CAD_STATE_SCHEMA_VERSION,
  type CadProjectHead,
  type CadProjectState,
  type CadRunState,
  type EvidenceRef,
} from "./protocol.ts";

export interface CadJournalEvent {
  at: string;
  type: string;
  data?: unknown;
}

export interface CadRunRef {
  runId: string;
  route: CadRunState["route"];
  phase: CadRunState["phase"];
  status: CadRunState["status"];
  createdAt: string;
  updatedAt: string;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return sha256(data);
}

export function hashRecord(record: unknown): string {
  return sha256(canonicalJson(record));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeEvidenceId(
  kind: EvidenceRef["kind"],
  artifactHash: string,
  specHash?: string,
  caseId?: string,
): string {
  let identity = artifactHash.slice(0, 12);
  if (caseId) identity = `${identity}-case-${caseId}`;
  else if (specHash) identity = `${identity}-${specHash.slice(0, 12)}`;
  return `${kind}-${identity}-${randomUUID().slice(0, 8)}`;
}

function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  return writeFile(tmp, content, "utf-8").then(async () => {
    await rename(tmp, path);
  });
}

export class CadRunStore {
  readonly cwd: string;
  readonly runId: string;
  readonly runDir: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly recordsDir: string;
  readonly requirementsDir: string;
  readonly evidenceDir: string;
  readonly artifactsDir: string;
  readonly reviewsDir: string;

  constructor(cwd: string, runId: string) {
    this.cwd = resolve(cwd);
    this.runId = runId;
    this.runDir = join(this.cwd, ".pi-cad", "runs", runId);
    this.statePath = join(this.runDir, "state.json");
    this.eventsPath = join(this.runDir, "events.jsonl");
    this.recordsDir = join(this.runDir, "records");
    this.requirementsDir = join(this.recordsDir, "requirements");
    this.evidenceDir = join(this.runDir, "evidence");
    this.artifactsDir = join(this.runDir, "artifacts");
    this.reviewsDir = join(this.runDir, "reviews");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(join(this.recordsDir), { recursive: true });
    await mkdir(this.requirementsDir, { recursive: true });
    await mkdir(join(this.evidenceDir, "visual"), { recursive: true });
    await mkdir(join(this.evidenceDir, "geometry"), { recursive: true });
    await mkdir(join(this.evidenceDir, "compare"), { recursive: true });
    await mkdir(join(this.evidenceDir, "section"), { recursive: true });
    await mkdir(join(this.artifactsDir), { recursive: true });
    await mkdir(join(this.reviewsDir), { recursive: true });
  }

  async load(): Promise<CadRunState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(raw) as CadRunState;
      if (!state || state.schemaVersion !== CAD_STATE_SCHEMA_VERSION) return null;
      return state;
    } catch {
      return null;
    }
  }

  async save(state: CadRunState): Promise<void> {
    await this.ensureDirs();
    await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async appendEvent(type: string, data?: unknown): Promise<void> {
    await this.ensureDirs();
    const event: CadJournalEvent = { at: nowIso(), type, data };
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  async writeRecord(name: string, data: unknown): Promise<string> {
    await this.ensureDirs();
    if (name === "requirements") await this.writeRequirementsVersion(hashRecord(data), data);
    const path = join(this.recordsDir, `${name}.json`);
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  requirementsVersionPath(version: string): string {
    if (!/^[a-f0-9]{64}$/.test(version)) throw new Error(`invalid requirements version: ${version}`);
    return join(this.requirementsDir, `${version}.json`);
  }

  async writeRequirementsVersion(version: string, data: unknown): Promise<string> {
    await this.ensureDirs();
    if (hashRecord(data) !== version) throw new Error("requirements record hash does not match version");
    const path = this.requirementsVersionPath(version);
    try {
      const existing = JSON.parse(await readFile(path, "utf-8"));
      if (hashRecord(existing) !== version) throw new Error(`immutable requirements record is corrupt: ${path}`);
      return path;
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.includes("corrupt"))) throw error;
    }
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  async readRequirementsVersion<T = unknown>(version: string): Promise<T> {
    const path = this.requirementsVersionPath(version);
    const data = JSON.parse(await readFile(path, "utf-8")) as T;
    if (hashRecord(data) !== version) throw new Error(`requirements record hash mismatch: ${path}`);
    return data;
  }

  async writeManifest(data: unknown): Promise<string> {
    await this.ensureDirs();
    const path = join(this.artifactsDir, "manifest.json");
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  async writeReview(data: unknown): Promise<string> {
    await this.ensureDirs();
    const existing = (await readdir(this.reviewsDir).catch(() => []))
      .filter((name) => /^review-\d+\.json$/.test(name));
    const next = existing.reduce((max, name) => {
      const value = Number(name.match(/\d+/)?.[0] ?? 0);
      return Math.max(max, value);
    }, 0) + 1;
    const path = join(this.reviewsDir, `review-${String(next).padStart(3, "0")}.json`);
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  async listReviewsNewestFirst<T = unknown>(): Promise<Array<{ path: string; data: T }>> {
    await this.ensureDirs();
    const names = (await readdir(this.reviewsDir).catch(() => []))
      .filter((name) => /^review-\d+\.json$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
    const reviews: Array<{ path: string; data: T }> = [];
    for (const name of names) {
      const path = join(this.reviewsDir, name);
      try {
        reviews.push({ path, data: JSON.parse(await readFile(path, "utf-8")) as T });
      } catch {
        // A partial or legacy-unreadable report is not a valid vote.
      }
    }
    return reviews;
  }

  async runRef(): Promise<CadRunRef | null> {
    const state = await this.load();
    if (!state) return null;
    return {
      runId: state.runId,
      route: state.route ?? null,
      phase: state.phase,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
}

export interface CreateRunOptions {
  runId?: string;
}

export class CadProjectStore {
  readonly cwd: string;
  readonly piCadDir: string;
  readonly runsDir: string;
  readonly projectPath: string;
  readonly projectId: string;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.projectId = basename(this.cwd) || "project";
    this.piCadDir = join(this.cwd, ".pi-cad");
    this.runsDir = join(this.piCadDir, "runs");
    this.projectPath = join(this.piCadDir, "project.json");
  }

  async ensure(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
  }

  async loadProject(): Promise<CadProjectState | null> {
    try {
      const raw = await readFile(this.projectPath, "utf-8");
      const project = JSON.parse(raw) as CadProjectState;
      if (!project || project.schemaVersion !== CAD_STATE_SCHEMA_VERSION) return null;
      return project;
    } catch {
      return null;
    }
  }

  async ensureProject(): Promise<CadProjectState> {
    const existing = await this.loadProject();
    if (existing) return existing;
    const createdAt = nowIso();
    const project: CadProjectState = {
      schemaVersion: CAD_STATE_SCHEMA_VERSION,
      projectId: this.projectId,
      head: { evidence: [], updatedAt: createdAt },
      currentRunId: null,
      createdAt,
      updatedAt: createdAt,
    };
    await this.ensure();
    await this.saveProject(project);
    return project;
  }

  async saveProject(project: CadProjectState): Promise<void> {
    await this.ensure();
    await atomicWrite(this.projectPath, `${JSON.stringify(project, null, 2)}\n`);
  }

  async currentRunId(): Promise<string | null> {
    const project = await this.ensureProject();
    return project.currentRunId;
  }

  async currentRun(): Promise<CadRunStore | null> {
    const runId = await this.currentRunId();
    return runId ? new CadRunStore(this.cwd, runId) : null;
  }

  async createRun(options: CreateRunOptions = {}): Promise<CadRunStore> {
    const runId = options.runId ?? (await this.generateRunId());
    const run = new CadRunStore(this.cwd, runId);
    await run.ensureDirs();
    const project = await this.ensureProject();
    project.currentRunId = runId;
    project.updatedAt = nowIso();
    await this.saveProject(project);
    return run;
  }

  async setCurrentRun(runId: string | null): Promise<void> {
    const project = await this.ensureProject();
    project.currentRunId = runId;
    project.updatedAt = nowIso();
    await this.saveProject(project);
  }

  async updateHead(head: Partial<CadProjectHead>): Promise<CadProjectState> {
    const project = await this.ensureProject();
    project.head = {
      ...project.head,
      ...head,
      evidence: head.evidence ?? project.head.evidence ?? [],
      updatedAt: nowIso(),
    };
    project.updatedAt = nowIso();
    await this.saveProject(project);
    return project;
  }

  async listRuns(): Promise<CadRunRef[]> {
    await this.ensure();
    let names: string[] = [];
    try {
      names = await readdir(this.runsDir);
    } catch {
      return [];
    }
    const refs: CadRunRef[] = [];
    for (const name of names.sort()) {
      const ref = await new CadRunStore(this.cwd, name).runRef();
      if (ref) refs.push(ref);
    }
    return refs;
  }

  run(runId: string): CadRunStore {
    return new CadRunStore(this.cwd, runId);
  }

  private async generateRunId(): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let names: string[] = [];
    try {
      names = await readdir(this.runsDir);
    } catch {
      names = [];
    }
    const prefix = `run-${date}-`;
    const sequence =
      names
        .filter((name) => name.startsWith(prefix))
        .map((name) => Number(name.slice(prefix.length)) || 0)
        .sort((a, b) => b - a)[0] ?? 0;
    return `${prefix}${String(sequence + 1).padStart(3, "0")}`;
  }

  // Convenience current-run delegation used by existing control tools.
  async load(): Promise<CadRunState | null> {
    const run = await this.currentRun();
    return run ? run.load() : null;
  }

  async save(state: CadRunState): Promise<void> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    await run.save(state);
  }

  async appendEvent(type: string, data?: unknown): Promise<void> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    await run.appendEvent(type, data);
  }

  async writeRecord(name: string, data: unknown): Promise<string> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    return run.writeRecord(name, data);
  }

  async writeRequirementsVersion(version: string, data: unknown): Promise<string> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    return run.writeRequirementsVersion(version, data);
  }

  async readRequirementsVersion<T = unknown>(version: string): Promise<T> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    return run.readRequirementsVersion<T>(version);
  }

  async writeManifest(data: unknown): Promise<string> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    return run.writeManifest(data);
  }

  async writeReview(data: unknown): Promise<string> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    return run.writeReview(data);
  }

  async listReviewsNewestFirst<T = unknown>(): Promise<Array<{ path: string; data: T }>> {
    const run = await this.currentRun();
    return run ? run.listReviewsNewestFirst<T>() : [];
  }

  async repairRequirementsRevisionJournal(state: CadRunState): Promise<boolean> {
    const revision = state.lastRequirementsRevision;
    if (!revision || revision.currentVersion !== state.requirementsVersion) return false;
    const run = this.run(state.runId);
    const raw = await readFile(run.eventsPath, "utf-8").catch(() => "");
    const alreadyRecorded = raw.split(/\r?\n/).filter(Boolean).some((line) => {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: { previousVersion?: string; currentVersion?: string; at?: string };
        };
        return (event.type === "RequirementsRevised" || event.type === "RequirementsRevisionJournalRecovered") &&
          event.data?.previousVersion === revision.previousVersion &&
          event.data?.currentVersion === revision.currentVersion &&
          event.data?.at === revision.at;
      } catch {
        return false;
      }
    });
    if (alreadyRecorded) return false;
    await run.appendEvent("RequirementsRevisionJournalRecovered", {
      ...revision,
      note: "state.json and immutable requirements record were authoritative; missing journal entry repaired on startup",
    });
    return true;
  }

  resolve(relativePath: string): string {
    return resolve(this.cwd, relativePath);
  }

  relative(absolutePath: string): string {
    const rel = absolutePath.startsWith(this.cwd)
      ? absolutePath.slice(this.cwd.length).replace(/^[/\\]/, "")
      : absolutePath;
    return rel || ".";
  }

  /**
   * Schema v3 → v4 (0.8 route ontology). v4 replaces `workflow` with the
   * hierarchical `route`; mapping a 0.7 workflow enum onto a route would be
   * lossy (quick has no route equivalent, maturity lived in requirements),
   * so migration is deliberately conservative:
   *
   *   - project.json: bump the version, keep the design head untouched;
   *   - active v3 runs (active/waiting_user/ready): abort with an explicit
   *     migration event — the user re-routes from intake with cad_route;
   *   - finished v3 runs: bump only, they are terminal history.
   */
  async migrateV3ToV4(): Promise<boolean> {
    await this.ensure();
    let migrated = false;

    // project.json
    try {
      const raw = JSON.parse(await readFile(this.projectPath, "utf-8")) as CadProjectState;
      if (raw.schemaVersion === 3) {
        raw.schemaVersion = 4;
        raw.updatedAt = nowIso();
        await this.saveProject(raw);
        migrated = true;
      }
    } catch {
      // no project file yet — ensureProject will create it at v4
    }

    // runs
    let names: string[] = [];
    try {
      names = await readdir(this.runsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const statePath = join(this.runsDir, name, "state.json");
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (state.schemaVersion !== 3) continue;
      const wasActive =
        state.status === "active" || state.status === "waiting_user" || state.status === "ready";
      delete state.workflow;
      delete state.maturity;
      state.schemaVersion = 4;
      state.route = null;
      state.updatedAt = nowIso();
      if (wasActive) state.status = "aborted";
      await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
      if (wasActive) {
        const run = new CadRunStore(this.cwd, name);
        await run
          .appendEvent("RunAbortedBySchemaMigration", {
            from: 3,
            to: 4,
            note: "0.8 route ontology: re-route from intake with cad_route; project head is unchanged",
          })
          .catch(() => {});
      }
      migrated = true;
    }
    return migrated;
  }

  /**
   * Schema v4 → v5 replaces implicit typed-solver evidence with the
   * Recipe-native simulate → observe → commit protocol. Active v4 runs are
   * aborted because their case obligations cannot be translated without
   * silently changing their declared tool identity. Terminal history and
   * the project head remain intact.
   */
  async migrateV4ToV5(): Promise<boolean> {
    await this.ensure();
    let migrated = false;
    try {
      const project = JSON.parse(await readFile(this.projectPath, "utf-8")) as CadProjectState;
      if (project.schemaVersion === 4) {
        project.schemaVersion = 5;
        project.updatedAt = nowIso();
        await this.saveProject(project);
        migrated = true;
      }
    } catch {
      // No project yet.
    }
    const names = await readdir(this.runsDir).catch(() => []);
    for (const name of names) {
      const statePath = join(this.runsDir, name, "state.json");
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (state.schemaVersion !== 4) continue;
      const wasActive = state.status === "active" || state.status === "waiting_user" || state.status === "ready";
      state.schemaVersion = 5;
      state.updatedAt = nowIso();
      if (wasActive) state.status = "aborted";
      await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
      if (wasActive) {
        await new CadRunStore(this.cwd, name).appendEvent("RunAbortedBySchemaMigration", {
          from: 4,
          to: 5,
          note: "Simulation V2 requires re-route and explicit Recipe-native case obligations; project head is unchanged",
        }).catch(() => {});
      }
      migrated = true;
    }
    return migrated;
  }

  /** Schema v5 -> v6 adds immutable requirements versions and retires revision approval. */
  async migrateV5ToV6(): Promise<boolean> {
    await this.ensure();
    let migrated = false;
    try {
      const project = JSON.parse(await readFile(this.projectPath, "utf-8")) as CadProjectState;
      if (project.schemaVersion === 5) {
        project.schemaVersion = 6;
        project.updatedAt = nowIso();
        await this.saveProject(project);
        migrated = true;
      }
    } catch {
      // No project yet.
    }

    const names = await readdir(this.runsDir).catch(() => []);
    for (const name of names) {
      const run = new CadRunStore(this.cwd, name);
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await readFile(run.statePath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (state.schemaVersion !== 5) continue;

      const version = typeof state.requirementsVersion === "string" ? state.requirementsVersion : undefined;
      if (version) {
        const legacyPath = join(run.recordsDir, "requirements.json");
        const record = JSON.parse(await readFile(legacyPath, "utf-8"));
        if (hashRecord(record) !== version) {
          throw new Error(`cannot migrate ${name}: requirements.json does not match requirementsVersion`);
        }
        await run.writeRequirementsVersion(version, record);
      }

      const discarded = state.pendingRequirementsRevision as {
        hash?: string;
        requestedAt?: string;
      } | null | undefined;
      delete state.pendingRequirementsRevision;
      delete state.requirementsAuthorityToken;
      delete state.requirementsAuthorityHash;
      const blocker = state.blocker as { type?: string; reason?: string; needed?: string } | undefined;
      if (
        blocker?.type === "user_authority" &&
        /requirements revision|approve-requirements-revision/i.test(`${blocker.reason ?? ""} ${blocker.needed ?? ""}`)
      ) {
        delete state.blocker;
        if (state.status === "blocked_user") state.status = "active";
      }
      state.schemaVersion = 6;
      state.updatedAt = nowIso();
      await atomicWrite(run.statePath, `${JSON.stringify(state, null, 2)}\n`);
      if (discarded) {
        await run.appendEvent("RequirementsRevisionApprovalRetired", {
          ...(discarded.hash ? { discardedProposalHash: discarded.hash } : {}),
          ...(discarded.requestedAt ? { discardedProposalRequestedAt: discarded.requestedAt } : {}),
          note: "v6 uses cad_revise_requirements; an unapproved v5 proposal was not applied",
        }).catch(() => {});
      }
      migrated = true;
    }
    return migrated;
  }

  /** All migrations: legacy layouts, then schema version steps. */
  async migrate(): Promise<boolean> {
    const legacy = await this.migrateLegacyProject();
    const v4 = await this.migrateV3ToV4();
    const v5 = await this.migrateV4ToV5();
    const v6 = await this.migrateV5ToV6();
    return legacy || v4 || v5 || v6;
  }

  /** Migrate V0 single-state and V0.4 task layouts into project + runs. */
  async migrateLegacyProject(): Promise<boolean> {
    await this.ensure();
    let migrated = false;

    const legacyTaskCurrent = join(this.piCadDir, "current.json");
    const legacyTasks = join(this.piCadDir, "tasks");
    try {
      const names = await readdir(legacyTasks);
      const currentRaw = JSON.parse(await readFile(legacyTaskCurrent, "utf-8")) as {
        activeTaskId?: string;
      };
      let headSource: CadProjectHead = { evidence: [], updatedAt: nowIso() };
      let currentRunId: string | null = null;
      for (const [index, name] of names.sort().entries()) {
        const taskState = JSON.parse(
          await readFile(join(legacyTasks, name, "state.json"), "utf-8"),
        ) as CadRunState & { taskId?: string };
        const runId = `run-migrated-${String(index + 1).padStart(3, "0")}`;
        const run = new CadRunStore(this.cwd, runId);
        await run.ensureDirs();
        const runState: CadRunState = {
          ...taskState,
          schemaVersion: CAD_STATE_SCHEMA_VERSION,
          runId,
          projectId: this.projectId,
          createdAt: taskState.createdAt ?? taskState.updatedAt,
        };
        await run.save(runState);
        await rename(join(legacyTasks, name, "events.jsonl"), run.eventsPath).catch(() => {});
        await rename(join(legacyTasks, name, "records"), run.recordsDir).catch(() => {});
        await rename(join(legacyTasks, name, "evidence"), run.evidenceDir).catch(() => {});
        await rename(join(legacyTasks, name, "artifacts"), run.artifactsDir).catch(() => {});

        if (taskState.taskId === currentRaw.activeTaskId && taskState.status === "active") {
          currentRunId = runId;
        }
        if (taskState.currentArtifactHash) {
          headSource = {
            sourcePath: taskState.currentSourcePath,
            sourceHash: taskState.currentSourceHash,
            artifactPath: taskState.currentArtifactPath,
            artifactHash: taskState.currentArtifactHash,
            evidence: taskState.evidence,
            updatedAt: nowIso(),
          };
        }
      }
      await this.saveProject({
        schemaVersion: CAD_STATE_SCHEMA_VERSION,
        projectId: this.projectId,
        head: headSource,
        currentRunId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      await rm(legacyTasks, { recursive: true, force: true });
      await rm(legacyTaskCurrent, { force: true });
      migrated = true;
    } catch {
      // fall through to legacy single-state migration
    }

    const legacyState = join(this.piCadDir, "state.json");
    try {
      const legacy = JSON.parse(await readFile(legacyState, "utf-8")) as CadRunState & {
        taskId?: string;
      };
      const run = await this.createRun({ runId: "run-migrated-legacy" });
      const runState: CadRunState = {
        ...legacy,
        schemaVersion: CAD_STATE_SCHEMA_VERSION,
        runId: run.runId,
        projectId: this.projectId,
        createdAt: legacy.createdAt ?? legacy.updatedAt,
      };
      await run.save(runState);
      await this.updateHead({
        sourcePath: legacy.currentSourcePath,
        sourceHash: legacy.currentSourceHash,
        artifactPath: legacy.currentArtifactPath,
        artifactHash: legacy.currentArtifactHash,
        evidence: legacy.evidence,
      });
      await this.setCurrentRun(legacy.status === "active" ? run.runId : null);
      await rm(legacyState, { force: true });
      await rename(join(this.piCadDir, "events.jsonl"), run.eventsPath).catch(() => {});
      migrated = true;
    } catch {
      // no legacy layout
    }
    return migrated;
  }
}

/** @deprecated use CadProjectStore */
export const ProjectStateStore = CadProjectStore;

export function cloneState<T>(state: T): T {
  return structuredClone(state);
}
