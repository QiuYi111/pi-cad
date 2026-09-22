import type { TraceEntry } from "../types.ts";
import type { Command } from "./model.ts";
import type { ReifySnapshot } from "./session.ts";

/** One observed state of the real system, kept for the failure artifact. */
export interface ReifyTimelineEntry {
  at: number;
  step: number;
  command: string;
  conversations: { id: string; runId: string | null; status: string | null }[];
  runs: { id: string; phase: string; status: string; artifacts: number; hashesOk: boolean }[];
  kernels: { pid: number; ppid: number; ownerPid: number | null; orphan: boolean }[];
  liveAuthorities: number[];
}

/** Command/note log plus the real-state timeline an artifact needs. */
export class ReifyTrace {
  readonly entries: TraceEntry[] = [];
  readonly timeline: ReifyTimelineEntry[] = [];
  readonly notes: string[] = [];
  readonly ids = { conversations: new Set<string>(), runs: new Set<string>(), kernels: new Set<string>() };
  /** Commands that really ran, in order; the sequence stops at the failure. */
  readonly executed: Command[] = [];
  private step = 0;

  record(entry: Omit<TraceEntry, "at"> & { at?: number }): void {
    this.entries.push({ at: entry.at ?? Date.now(), ...entry });
  }

  note(message: string, detail?: unknown): void {
    this.notes.push(message);
    this.record({ kind: "note", name: message, detail });
  }

  observe(snapshot: ReifySnapshot, command: string): void {
    this.step += 1;
    for (const conversation of snapshot.conversations) this.ids.conversations.add(conversation.id);
    for (const run of snapshot.runs) this.ids.runs.add(run.id);
    for (const kernel of snapshot.kernels) this.ids.kernels.add(String(kernel.pid));
    this.timeline.push({
      at: snapshot.at,
      step: this.step,
      command,
      conversations: snapshot.conversations.map((conversation) => ({
        id: conversation.id,
        runId: conversation.runId,
        status: conversation.runStatus,
      })),
      runs: snapshot.runs.map((run) => ({
        id: run.id,
        phase: run.phase,
        status: run.status,
        artifacts: run.artifacts.length,
        hashesOk: run.artifacts.every((artifact) => artifact.sha256OnDisk === artifact.sha256),
      })),
      kernels: snapshot.kernels.map((kernel) => ({
        pid: kernel.pid,
        ppid: kernel.ppid,
        ownerPid: kernel.ownerPid,
        orphan: kernel.orphan,
      })),
      liveAuthorities: snapshot.liveAuthorities,
    });
  }
}
