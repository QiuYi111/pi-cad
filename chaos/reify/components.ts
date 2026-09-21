import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildIdentityGraph, type IdentityGraph } from "./identity.ts";
import {
  inspectDesktopProjection,
  inspectProviderBoundary,
  inspectWslBoundary,
  type DesktopConsistencyPair,
  type ProviderBoundary,
  type WslBoundary,
} from "./inspect.ts";
import { inspectPrimeProcesses, type PrimeProcess } from "./prime.ts";
import type { ReifyRuntime } from "./runtime.ts";
import type { ReifySession } from "./session.ts";

/** A real runtime process the runner started or observed, for the identity graph. */
export interface RuntimeObservation {
  kind: "authority" | "prime";
  pid: number;
  startedAt: number;
  /** Runs created/advanced through this runtime pid. */
  runIds: string[];
}

export interface PrimeRuntimeObservation {
  pid: number;
  provider: string;
  model: string;
  thinking: string;
  sessionId: string | null;
  alive: boolean;
}

export interface PrimeObservation {
  available: boolean;
  processes: PrimeProcess[];
  runtime: PrimeRuntimeObservation | null;
  journal: { at: string; phase: string; event: string }[];
}

/** The full set of real components the chaos slice can now connect to. */
export interface ReifyComponents {
  provider: ProviderBoundary;
  desktop: DesktopConsistencyPair;
  prime: PrimeObservation;
  wsl: WslBoundary;
  identities: IdentityGraph;
  /** How much of the machine the identity graph was scoped to. */
  machine: { kernels: number; foreignKernels: number };
}

/** The Desktop runtime journal Prime writes, when a Desktop run has been here. */
export function readDesktopRuntimeJournal(project: string): PrimeObservation["journal"] {
  const path = join(project, ".pi-cad", "desktop-runtime.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as { at: string; phase: string; event: string })
      .slice(-50);
  } catch {
    return [];
  }
}

export interface InspectReifyOptions {
  runtimes?: RuntimeObservation[];
  /** A live real Prime runtime the caller started, if any. */
  prime?: { pid: number; provider: string; model: string; thinking: string; sessionId: string | null; alive: boolean } | null;
  providerOverride?: { provider?: string; model?: string };
  probeProvider?: boolean;
  expectedRunId?: string | null;
}

/**
 * Observe every real component the slice now connects to, and join them into
 * one identity graph. This is the single source the artifact and the CLI read,
 * so the runner and the CLI always report the same real state.
 */
export async function inspectReifyComponents(session: ReifySession, options: InspectReifyOptions = {}): Promise<ReifyComponents> {
  const snapshot = await session.snapshot();
  const provider = await inspectProviderBoundary({ override: options.providerOverride, probe: options.probeProvider });
  const desktop = inspectDesktopProjection(session.project, session.canonical, options.expectedRunId ?? snapshot.project.currentRunId);
  const wsl = await inspectWslBoundary();
  const primeProcesses = inspectPrimeProcesses();
  const prime: PrimeObservation = {
    available: options.prime != null || primeProcesses.length > 0,
    processes: primeProcesses,
    runtime: options.prime ?? null,
    journal: readDesktopRuntimeJournal(session.project),
  };
  const runtimes = [...(options.runtimes ?? [])];
  if (options.prime?.pid) {
    runtimes.push({ kind: "prime", pid: options.prime.pid, startedAt: Date.now(), runIds: [] });
  }
  const providerRequests = [
    {
      id: `${provider.selection.provider}:${provider.selection.model}`,
      provider: provider.selection.provider,
      model: provider.selection.model,
      label: provider.probe.url ?? `${provider.selection.provider} (no endpoint)`,
      ok: provider.probe.ok,
    },
  ];
  // The machine is shared: only kernels this session really owns (or that it
  // has positively identified as orphans) belong to our identity graph. Other
  // workspaces' kernels are counted, not claimed.
  const ownKernels = snapshot.kernels.filter((kernel) => kernel.ownerPid !== null || kernel.orphan);
  const identities = buildIdentityGraph({
    project: { id: snapshot.project.id, root: session.project, canonical: session.canonical },
    conversations: snapshot.conversations.map((conversation) => ({
      id: conversation.id,
      runId: conversation.runId,
      runStatus: conversation.runStatus,
    })),
    runs: snapshot.runs.map((run) => ({ id: run.id, phase: run.phase, status: run.status })),
    runtimes,
    kernels: ownKernels.map((kernel) => ({ pid: kernel.pid, ppid: kernel.ppid, ownerPid: kernel.ownerPid, orphan: kernel.orphan })),
    providerRequests,
  });
  return {
    provider,
    desktop,
    prime,
    wsl,
    identities,
    machine: { kernels: snapshot.kernels.length, foreignKernels: snapshot.kernels.length - ownKernels.length },
  };
}

/** Runtime observation for a started adapter, used by the CLI. */
export function runtimeObservation(runtime: ReifyRuntime, runIds: string[]): RuntimeObservation {
  return { kind: "authority", pid: runtime.pid, startedAt: runtime.current?.startedAt ?? Date.now(), runIds };
}
