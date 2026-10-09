import { post, waitFor } from "./http.ts";
import { ControlPlaneClient } from "./client.ts";
import { spawnEntry, freePort, type SpawnedEntry } from "./proc.ts";
import {
  startToxiproxyServer,
  toxiproxyAvailable,
  type ToxiproxyClient,
  type ToxiproxyServer,
} from "./toxiproxy.ts";
import type { BugName, Snapshot } from "./server.ts";
import { FaultRuntime } from "../faults/runtime.ts";

export const PROXY_NAME = "llm";

/** Invariant history carried across the steps of one chaos iteration. */
export class SessionHistory {
  createdRuns = 0;
  readonly terminalSeen = new Set<string>();
  readonly deadWorkerSince = new Map<string, number>();
  readonly stalledRunSince = new Map<string, number>();
}

export interface SessionOptions {
  bug?: BugName | null;
  /** Force the external-fault path off (used when toxiproxy is unavailable). */
  external?: boolean;
}

export class Session {
  readonly history = new SessionHistory();
  readonly faults: FaultRuntime;
  readonly upstreamUrl: string;
  readonly externalUrl: string;
  readonly bug: BugName | null;
  readonly toxiproxyClient: ToxiproxyClient | null;
  readonly client: ControlPlaneClient;

  private constructor(
    private readonly upstreamEntry: SpawnedEntry,
    private readonly controlEntry: SpawnedEntry,
    private readonly toxiproxy: ToxiproxyServer | null,
    options: {
      upstreamUrl: string;
      externalUrl: string;
      bug: BugName | null;
      controlUrl: string;
      toxiproxyClient: ToxiproxyClient | null;
    },
  ) {
    this.upstreamUrl = options.upstreamUrl;
    this.externalUrl = options.externalUrl;
    this.bug = options.bug;
    this.toxiproxyClient = options.toxiproxyClient;
    this.client = new ControlPlaneClient(options.controlUrl);
    this.faults = new FaultRuntime(this);
  }

  static async start(options: SessionOptions = {}): Promise<Session> {
    const upstreamEntry = spawnEntry("__upstream");
    const upstreamMatch = await upstreamEntry.waitForLine(/CHAOS_UPSTREAM_READY (\S+)/);
    const upstreamUrl = upstreamMatch[1];

    let toxiproxy: ToxiproxyServer | null = null;
    let toxiproxyClient: ToxiproxyClient | null = null;
    let externalUrl = upstreamUrl;
    if (options.external !== false && toxiproxyAvailable()) {
      toxiproxy = await startToxiproxyServer();
      toxiproxyClient = toxiproxy.client;
      const proxyPort = await freePort();
      await toxiproxyClient.createProxy(PROXY_NAME, proxyPort, upstreamUrl);
      externalUrl = `http://127.0.0.1:${proxyPort}`;
    }

    const controlEntry = spawnEntry("__serve", [
      "--external",
      externalUrl,
      "--bug",
      options.bug ?? "",
    ]);
    const controlMatch = await controlEntry.waitForLine(/CHAOS_CONTROL_READY (\S+)/);
    const controlUrl = controlMatch[1];

    return new Session(upstreamEntry, controlEntry, toxiproxy, {
      upstreamUrl,
      externalUrl,
      bug: options.bug ?? null,
      controlUrl,
      toxiproxyClient,
    });
  }

  get hasExternalFaults(): boolean {
    return this.toxiproxyClient !== null;
  }

  async snapshot(): Promise<Snapshot> {
    return this.client.snapshot();
  }

  /** Reset run/worker state and undo every fault before the next iteration. */
  async reset(): Promise<void> {
    await this.client.reset();
    await post(`${this.upstreamUrl}/reset`).catch(() => undefined);
    if (this.toxiproxyClient) await this.toxiproxyClient.reset().catch(() => undefined);
    this.history.createdRuns = 0;
    this.history.terminalSeen.clear();
    this.history.deadWorkerSince.clear();
    this.history.stalledRunSince.clear();
  }

  async waitQuiescent(timeoutMs = 2_500): Promise<void> {
    await waitFor(
      async () => {
        const snapshot = await this.snapshot();
        return snapshot.runs.every((run) => run.state !== "STARTING" && run.state !== "STOPPING");
      },
      { timeoutMs, intervalMs: 25, label: "all runs out of a transition state" },
    ).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.controlEntry.stop();
    await this.upstreamEntry.stop();
    if (this.toxiproxy) await this.toxiproxy.stop();
  }
}
