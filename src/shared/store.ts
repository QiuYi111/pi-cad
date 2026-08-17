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
import { join, resolve } from "node:path";

import {
  CAD_STATE_SCHEMA_VERSION,
  type CadProjectState,
  type EvidenceRef,
} from "./protocol.ts";

export interface CadJournalEvent {
  at: string;
  type: string;
  data?: unknown;
}

export interface CadTaskRef {
  taskId: string;
  parentTaskId?: string;
  workflow: CadProjectState["workflow"];
  phase: CadProjectState["phase"];
  status: CadProjectState["status"];
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

export class CadTaskStore {
  readonly cwd: string;
  readonly taskId: string;
  readonly taskDir: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly recordsDir: string;
  readonly evidenceDir: string;
  readonly artifactsDir: string;

  constructor(cwd: string, taskId: string) {
    this.cwd = resolve(cwd);
    this.taskId = taskId;
    this.taskDir = join(this.cwd, ".pi-cad", "tasks", taskId);
    this.statePath = join(this.taskDir, "state.json");
    this.eventsPath = join(this.taskDir, "events.jsonl");
    this.recordsDir = join(this.taskDir, "records");
    this.evidenceDir = join(this.taskDir, "evidence");
    this.artifactsDir = join(this.taskDir, "artifacts");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(join(this.recordsDir), { recursive: true });
    await mkdir(join(this.evidenceDir, "visual"), { recursive: true });
    await mkdir(join(this.evidenceDir, "geometry"), { recursive: true });
    await mkdir(join(this.evidenceDir, "compare"), { recursive: true });
    await mkdir(join(this.evidenceDir, "section"), { recursive: true });
    await mkdir(join(this.artifactsDir), { recursive: true });
  }

  async load(): Promise<CadProjectState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(raw) as CadProjectState;
      if (!state || state.schemaVersion !== CAD_STATE_SCHEMA_VERSION) return null;
      return state;
    } catch {
      return null;
    }
  }

  async save(state: CadProjectState): Promise<void> {
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

  async taskRef(): Promise<CadTaskRef | null> {
    const state = await this.load();
    if (!state) return null;
    return {
      taskId: state.taskId,
      parentTaskId: state.parentTaskId,
      workflow: state.workflow,
      phase: state.phase,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
}

export interface CreateTaskOptions {
  taskId?: string;
  parentTaskId?: string;
}

export class CadProjectStore {
  readonly cwd: string;
  readonly piCadDir: string;
  readonly tasksDir: string;
  readonly currentPath: string;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.piCadDir = join(this.cwd, ".pi-cad");
    this.tasksDir = join(this.piCadDir, "tasks");
    this.currentPath = join(this.piCadDir, "current.json");
  }

  async ensure(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
  }

  async currentTaskId(): Promise<string | null> {
    await this.ensure();
    try {
      const raw = JSON.parse(await readFile(this.currentPath, "utf-8")) as {
        activeTaskId?: string;
      };
      return raw.activeTaskId ?? null;
    } catch {
      return null;
    }
  }

  async currentTask(): Promise<CadTaskStore | null> {
    const taskId = await this.currentTaskId();
    return taskId ? new CadTaskStore(this.cwd, taskId) : null;
  }

  async setCurrentTask(taskId: string): Promise<void> {
    await this.ensure();
    await atomicWrite(
      this.currentPath,
      `${JSON.stringify({ activeTaskId: taskId }, null, 2)}\n`,
    );
  }

  async createTask(options: CreateTaskOptions = {}): Promise<CadTaskStore> {
    await this.ensure();
    const taskId =
      options.taskId ?? (await this.generateTaskId());
    const task = new CadTaskStore(this.cwd, taskId);
    await task.ensureDirs();
    await this.setCurrentTask(taskId);
    return task;
  }

  async listTasks(): Promise<CadTaskRef[]> {
    await this.ensure();
    let names: string[] = [];
    try {
      names = await readdir(this.tasksDir);
    } catch {
      return [];
    }
    const refs: CadTaskRef[] = [];
    for (const name of names.sort()) {
      const task = new CadTaskStore(this.cwd, name);
      const ref = await task.taskRef();
      if (ref) refs.push(ref);
    }
    return refs;
  }

  async task(taskId: string): Promise<CadTaskStore> {
    return new CadTaskStore(this.cwd, taskId);
  }

  async removeTask(taskId: string): Promise<void> {
    await rm(join(this.tasksDir, taskId), { recursive: true, force: true });
  }

  private async generateTaskId(): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let names: string[] = [];
    try {
      names = await readdir(this.tasksDir);
    } catch {
      names = [];
    }
    const prefix = `cad-${date}-`;
    const sequence =
      names
        .filter((name) => name.startsWith(prefix))
        .map((name) => Number(name.slice(prefix.length)) || 0)
        .sort((a, b) => b - a)[0] ?? 0;
    return `${prefix}${String(sequence + 1).padStart(3, "0")}`;
  }

  // Convenience methods for current-task call sites. These do not make the
  // project store own task state; they delegate to the active task store.
  async load(): Promise<CadProjectState | null> {
    const task = await this.currentTask();
    return task ? task.load() : null;
  }

  async save(state: CadProjectState): Promise<void> {
    const task = await this.currentTask();
    if (!task) throw new Error("no active CAD task");
    await task.save(state);
  }

  async appendEvent(type: string, data?: unknown): Promise<void> {
    const task = await this.currentTask();
    if (!task) throw new Error("no active CAD task");
    await task.appendEvent(type, data);
  }

  async writeRecord(name: string, data: unknown): Promise<string> {
    const task = await this.currentTask();
    if (!task) throw new Error("no active CAD task");
    return task.writeRecord(name, data);
  }

  async writeManifest(data: unknown): Promise<string> {
    const task = await this.currentTask();
    if (!task) throw new Error("no active CAD task");
    return task.writeManifest(data);
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

  /** One-time migration from the V0 single-state layout. */
  async migrateLegacyProject(): Promise<boolean> {
    await this.ensure();
    const legacyState = join(this.piCadDir, "state.json");
    let legacy: CadProjectState;
    try {
      legacy = JSON.parse(await readFile(legacyState, "utf-8")) as CadProjectState;
    } catch {
      return false;
    }
    const taskId =
      legacy.taskId && legacy.taskId !== "legacy-task"
        ? legacy.taskId
        : `cad-legacy-${Date.now().toString(36)}`;
    const task = await this.createTask({ taskId });
    const normalized: CadProjectState = {
      ...legacy,
      schemaVersion: CAD_STATE_SCHEMA_VERSION,
      taskId,
      createdAt: legacy.updatedAt ?? nowIso(),
    };
    await task.save(normalized);
    for (const [from, to] of [
      [join(this.piCadDir, "events.jsonl"), task.eventsPath],
      [join(this.piCadDir, "records"), task.recordsDir],
      [join(this.piCadDir, "evidence"), task.evidenceDir],
      [join(this.piCadDir, "artifacts"), task.artifactsDir],
    ] as const) {
      try {
        await rename(from, to);
      } catch {
        // Missing optional directory.
      }
    }
    try {
      await rm(legacyState, { force: true });
    } catch {
      // Already absent.
    }
    return true;
  }
}

/** @deprecated use CadProjectStore */
export const ProjectStateStore = CadProjectStore;

export function cloneState(state: CadProjectState): CadProjectState {
  return structuredClone(state);
}
