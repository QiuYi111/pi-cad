import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  CAD_STATE_SCHEMA_VERSION,
  type CadProjectHead,
  type CadProjectState,
  type CadRunState,
} from "./protocol.ts";
import { nowIso } from "./hash.ts";

export { hashRecord, makeEvidenceId, nowIso, sha256File, stableJson } from "./hash.ts";

/**
 * Legacy v6 run-state store. The v6 kernel is removed: nothing writes new v6
 * runs. These classes remain only as the read/append surface that the
 * remaining shared readers still use (current-run lookup, state load and
 * journal append). Project pointer creation is kept for the simulation
 * analysis fixtures.
 */

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

  constructor(cwd: string, runId: string) {
    this.cwd = resolve(cwd);
    this.runId = runId;
    this.runDir = join(this.cwd, ".pi-cad", "runs", runId);
    this.statePath = join(this.runDir, "state.json");
    this.eventsPath = join(this.runDir, "events.jsonl");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
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

export class CadProjectStore {
  readonly cwd: string;
  readonly runsDir: string;
  readonly projectPath: string;
  readonly projectId: string;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.projectId = basename(this.cwd) || "project";
    this.runsDir = join(this.cwd, ".pi-cad", "runs");
    this.projectPath = join(this.cwd, ".pi-cad", "project.json");
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
    // Reads must stay side-effect free: before_agent_start calls load() on
    // every prompt, including in directories that have never used Pi-CAD.
    const project = await this.loadProject();
    if (!project) return null;
    return project.currentRunId;
  }

  async currentRun(): Promise<CadRunStore | null> {
    const runId = await this.currentRunId();
    return runId ? new CadRunStore(this.cwd, runId) : null;
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

  // Current-run delegation for the remaining readers.
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
}
