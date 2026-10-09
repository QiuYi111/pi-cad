import type { Arbitrary } from "fast-check";
import type { Session } from "./sut/session.ts";
import type { Snapshot } from "./sut/server.ts";

export type Params = Record<string, unknown>;

export interface ChaosContext {
  session: Session;
  trace: Trace;
  params: Params;
}

export interface InvariantContext {
  session: Session;
  snapshot: Snapshot;
  now: number;
}

/** An Action is one user/system step against the running system. */
export interface ActionDefinition {
  name: string;
  description: string;
  arbitrary: Arbitrary<Params>;
  describe(params: Params): string;
  run(ctx: ChaosContext): Promise<void>;
}

/** A Fault is injected, then recovered; recovery is best-effort and idempotent. */
export interface FaultDefinition {
  name: string;
  description: string;
  arbitrary: Arbitrary<Params>;
  describe(params: Params): string;
  inject(ctx: ChaosContext): Promise<void>;
  recover(ctx: ChaosContext): Promise<void>;
}

export interface InvariantDefinition {
  name: string;
  description: string;
  check(ctx: InvariantContext): Promise<void>;
}

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly detail: string,
    readonly evidence: unknown = undefined,
  ) {
    super(`${invariant}: ${detail}`);
    this.name = "InvariantViolation";
  }
}

export interface TraceEntry {
  at: number;
  kind: "command" | "invariant" | "note";
  name: string;
  detail?: unknown;
}

/** Compact per-step record used to build the failure artifact. */
export interface TimelineEntry {
  at: number;
  step: number;
  command: string;
  runs: { id: string; state: string; workerId: string | null; activeWorkers: number; effects: number }[];
  workers: { id: string; runId: string; status: string; pid: number }[];
}

export class Trace {
  readonly entries: TraceEntry[] = [];
  readonly timeline: TimelineEntry[] = [];
  readonly ids = { projects: new Set<string>(), runs: new Set<string>(), workers: new Set<string>() };
  readonly notes: string[] = [];
  private step = 0;

  record(entry: Omit<TraceEntry, "at"> & { at?: number }) {
    this.entries.push({ at: entry.at ?? Date.now(), ...entry });
  }

  note(message: string, detail?: unknown) {
    this.notes.push(message);
    this.record({ kind: "note", name: message, detail });
  }

  observe(snapshot: Snapshot, command: string) {
    this.step += 1;
    for (const project of snapshot.projects) this.ids.projects.add(project.id);
    for (const run of snapshot.runs) this.ids.runs.add(run.id);
    for (const worker of snapshot.workers) this.ids.workers.add(worker.id);
    this.timeline.push({
      at: Date.now(),
      step: this.step,
      command,
      runs: snapshot.runs.map((run) => ({
        id: run.id,
        state: run.state,
        workerId: run.workerId,
        activeWorkers: run.activeWorkers.length,
        effects: run.effectTokens.length,
      })),
      workers: snapshot.workers
        .filter((worker) => worker.status !== "exited")
        .map((worker) => ({ id: worker.id, runId: worker.runId, status: worker.status, pid: worker.pid })),
    });
  }

  get lastStep(): number {
    return this.step;
  }
}
