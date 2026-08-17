import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

export class ProjectStateStore {
  readonly cwd: string;
  readonly piCadDir: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly recordsDir: string;
  readonly evidenceDir: string;
  readonly artifactsDir: string;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.piCadDir = join(this.cwd, ".pi-cad");
    this.statePath = join(this.piCadDir, "state.json");
    this.eventsPath = join(this.piCadDir, "events.jsonl");
    this.recordsDir = join(this.piCadDir, "records");
    this.evidenceDir = join(this.piCadDir, "evidence");
    this.artifactsDir = join(this.piCadDir, "artifacts");
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(join(this.recordsDir), { recursive: true });
    await mkdir(join(this.evidenceDir, "visual"), { recursive: true });
    await mkdir(join(this.evidenceDir, "geometry"), { recursive: true });
    await mkdir(join(this.artifactsDir), { recursive: true });
  }

  async load(): Promise<CadProjectState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(raw) as CadProjectState;
      if (!state || state.schemaVersion !== CAD_STATE_SCHEMA_VERSION) {
        return null;
      }
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

  resolve(relativePath: string): string {
    return resolve(this.cwd, relativePath);
  }

  relative(absolutePath: string): string {
    const rel = absolutePath.startsWith(this.cwd)
      ? absolutePath.slice(this.cwd.length).replace(/^[/\\]/, "")
      : absolutePath;
    return rel || ".";
  }
}

export function cloneState(state: CadProjectState): CadProjectState {
  return structuredClone(state);
}
