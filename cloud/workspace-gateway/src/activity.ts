import { basename } from "node:path";
import type { ActivityReport } from "@reify/cloud-protocol";

export const ACTIVITY_WINDOW_MS = 60_000;
const MAX_PARTIAL_LINE = 1024 * 1024;

type Tracked = { ignored: boolean; partial: string; decoder: TextDecoder };

// Tracks what makes the workspace busy: running spawns (except ignored
// commands), Prime turns seen as agent_start / agent_end events on stdout, and
// bridge messages received within the activity window.
export class ActivityMonitor {
  private readonly tracked = new Map<string, Tracked>();
  private readonly turns = new Set<string>();
  private readonly now: () => number;
  private readonly ignoredCommands: Set<string>;
  private lastMessageAt: number | undefined;

  constructor(options: { now?: () => number; ignoredCommands?: string[] } = {}) {
    this.now = options.now ?? Date.now;
    this.ignoredCommands = new Set(options.ignoredCommands ?? []);
  }

  noteMessage(): void {
    this.lastMessageAt = this.now();
  }

  processStarted(id: string, argv: string[]): void {
    this.tracked.set(id, { ignored: this.ignoredCommands.has(basename(argv[0] ?? "")), partial: "", decoder: new TextDecoder() });
  }

  processStopped(id: string): void {
    this.tracked.delete(id);
    this.turns.delete(id);
  }

  stdout(id: string, chunk: Uint8Array): void {
    const entry = this.tracked.get(id);
    if (!entry) return;
    const lines = (entry.partial + entry.decoder.decode(chunk, { stream: true })).split("\n");
    entry.partial = lines.pop() ?? "";
    if (entry.partial.length > MAX_PARTIAL_LINE) entry.partial = "";
    for (const line of lines) this.event(id, line);
  }

  snapshot(): ActivityReport {
    if (this.turns.size > 0) return { active: true, reason: "prime-turn" };
    if ([...this.tracked.values()].some((entry) => !entry.ignored)) return { active: true, reason: "process" };
    if (this.lastMessageAt !== undefined && this.now() - this.lastMessageAt < ACTIVITY_WINDOW_MS) return { active: true, reason: "bridge-message" };
    return { active: false, reason: "idle" };
  }

  private event(id: string, line: string): void {
    let type: unknown;
    try {
      type = (JSON.parse(line) as { type?: unknown } | null)?.type;
    } catch {
      return;
    }
    if (type === "agent_start") this.turns.add(id);
    else if (type === "agent_end") this.turns.delete(id);
  }
}

export type ActivityReporterOptions = {
  monitor: ActivityMonitor;
  post: (report: ActivityReport) => Promise<unknown>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export function startActivityReporter(options: ActivityReporterOptions) {
  const tick = () => options.post(options.monitor.snapshot()).catch((error: unknown) => (options.onError ?? console.error)(error));
  const timer = setInterval(tick, options.intervalMs ?? 60_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

export function httpPoster(url: string, token: string) {
  return async (report: ActivityReport) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(report),
    });
    if (!response.ok) throw new Error(`activity report failed with ${response.status}`);
  };
}
