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
  workflow: CadRunState["workflow"];
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
  return sha256(JSON.stringify(record, Object.keys(record as object).sort(), 2));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeEvidenceId(kind: EvidenceRef["kind"], artifactHash: string): string {
  return `${kind}-${artifactHash.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
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
  readonly evidenceDir: string;
  readonly artifactsDir: string;

  constructor(cwd: string, runId: string) {
    this.cwd = resolve(cwd);
    this.runId = runId;
    this.runDir = join(this.cwd, ".pi-cad", "runs", runId);
    this.statePath = join(this.runDir, "state.json");
    this.eventsPath = join(this.runDir, "events.jsonl");
    this.recordsDir = join(this.runDir, "records");
    this.evidenceDir = join(this.runDir, "evidence");
    this.artifactsDir = join(this.runDir, "artifacts");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(join(this.recordsDir), { recursive: true });
    await mkdir(join(this.evidenceDir, "visual"), { recursive: true });
    await mkdir(join(this.evidenceDir, "geometry"), { recursive: true });
    await mkdir(join(this.evidenceDir, "compare"), { recursive: true });
    await mkdir(join(this.evidenceDir, "section"), { recursive: true });
    await mkdir(join(this.artifactsDir), { recursive: true });
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
    const path = join(this.recordsDir, `${name}.json`);
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  async writeManifest(data: unknown): Promise<string> {
    await this.ensureDirs();
    const path = join(this.artifactsDir, "manifest.json");
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  async runRef(): Promise<CadRunRef | null> {
    const state = await this.load();
    if (!state) return null;
    return {
      runId: state.runId,
      workflow: state.workflow,
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

  async writeManifest(data: unknown): Promise<string> {
    const run = await this.currentRun();
    if (!run) throw new Error("no active workflow run");
    return run.writeManifest(data);
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
