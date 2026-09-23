import fc from "fast-check";
import type { ChaosContext, FaultDefinition, Params } from "../types.ts";
import type { Snapshot, WorkerView } from "../sut/server.ts";
import { pickByIndex, runIndexParams } from "../actions/index.ts";
import { PROXY_NAME } from "../sut/session.ts";
import { isProcessAlive } from "../sut/proc.ts";

const LATENCY_TOXIC = "chaos-latency";
const DISCONNECT_TOXIC = "chaos-disconnect";

function activeWorker(snapshot: Snapshot, runIndex: number): WorkerView | undefined {
  const run = pickByIndex(
    (() => {
      const withWorker = snapshot.runs.filter((candidate) => candidate.activeWorkers.length > 0);
      return withWorker.length > 0 ? withWorker : snapshot.runs;
    })(),
    runIndex,
  );
  if (run) {
    const workerId = run.activeWorkers[0] ?? run.workerId;
    const worker = workerId
      ? snapshot.workers.find((candidate) => candidate.id === workerId && candidate.status !== "exited")
      : undefined;
    if (worker) return worker;
  }
  // Fall back to any live worker so the fault still lands somewhere real.
  return snapshot.workers.find((worker) => worker.status !== "exited" && isProcessAlive(worker.pid));
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Stop/restart a worker by killing its OS process (the Pumba `kill` analog). */
export const killWorker: FaultDefinition = {
  name: "killWorker",
  description: "SIGKILL 掉 run 的 worker 进程",
  arbitrary: runIndexParams(),
  describe: (params) => `killWorker(run#${params.runIndex})`,
  inject: async (ctx: ChaosContext) => {
    const snapshot = await ctx.session.snapshot();
    const worker = activeWorker(snapshot, Number(ctx.params.runIndex ?? 0));
    if (!worker) {
      ctx.trace.note("killWorker skipped: no active worker");
      return;
    }
    const ok = signal(worker.pid, "SIGKILL");
    ctx.trace.record({ kind: "command", name: "killWorker", detail: { workerId: worker.id, pid: worker.pid, ok } });
  },
  recover: async (ctx) => {
    ctx.trace.note("killWorker recover: no-op");
  },
};

/** Pause a worker with SIGSTOP (the Pumba `pause` analog). */
export const pauseWorker: FaultDefinition = {
  name: "pauseWorker",
  description: "SIGSTOP 暂停 run 的 worker 进程",
  arbitrary: runIndexParams(),
  describe: (params) => `pauseWorker(run#${params.runIndex})`,
  inject: async (ctx) => {
    const snapshot = await ctx.session.snapshot();
    const worker = activeWorker(snapshot, Number(ctx.params.runIndex ?? 0));
    if (!worker) {
      ctx.trace.note("pauseWorker skipped: no active worker");
      return;
    }
    const ok = signal(worker.pid, "SIGSTOP");
    ctx.trace.record({ kind: "command", name: "pauseWorker", detail: { workerId: worker.id, pid: worker.pid, ok } });
  },
  recover: async (ctx) => {
    const snapshot = await ctx.session.snapshot();
    for (const worker of snapshot.workers) {
      if (worker.status !== "exited") signal(worker.pid, "SIGCONT");
    }
    ctx.trace.note("pauseWorker recover: SIGCONT all live workers");
  },
};

/** External API timeout via a Toxiproxy latency toxic. */
export const externalLatency: FaultDefinition = {
  name: "externalLatency",
  description: "给外部 API 连接加延迟（触发客户端 timeout）",
  arbitrary: fc.record({ latencyMs: fc.integer({ min: 600, max: 1_400 }) }),
  describe: (params) => `externalLatency(${params.latencyMs}ms)`,
  inject: async (ctx) => {
    const client = requireToxiproxy(ctx);
    await client.addToxic(PROXY_NAME, {
      name: LATENCY_TOXIC,
      type: "latency",
      stream: "downstream",
      attributes: { latency: Number(ctx.params.latencyMs ?? 800) },
    });
    ctx.trace.record({ kind: "command", name: "externalLatency", detail: ctx.params });
  },
  recover: async (ctx) => {
    const client = requireToxiproxy(ctx);
    await client.removeToxic(PROXY_NAME, LATENCY_TOXIC);
    ctx.trace.note("externalLatency recovered");
  },
};

/** External API connection reset / reconnect via a Toxiproxy reset_peer toxic. */
export const externalDisconnect: FaultDefinition = {
  name: "externalDisconnect",
  description: "外部 API 连接被重置",
  arbitrary: fc.constant<Params>({}),
  describe: () => "externalDisconnect",
  inject: async (ctx) => {
    const client = requireToxiproxy(ctx);
    await client.addToxic(PROXY_NAME, {
      name: DISCONNECT_TOXIC,
      type: "reset_peer",
      stream: "downstream",
      attributes: { timeout: 0 },
    });
    ctx.trace.record({ kind: "command", name: "externalDisconnect" });
  },
  recover: async (ctx) => {
    const client = requireToxiproxy(ctx);
    await client.removeToxic(PROXY_NAME, DISCONNECT_TOXIC);
    ctx.trace.note("externalDisconnect recovered");
  },
};

/** External dependency fully unreachable (connection refused). */
export const externalDown: FaultDefinition = {
  name: "externalDown",
  description: "外部 API 完全不可达",
  arbitrary: fc.constant<Params>({}),
  describe: () => "externalDown",
  inject: async (ctx) => {
    const client = requireToxiproxy(ctx);
    await client.stopProxy(PROXY_NAME);
    ctx.trace.record({ kind: "command", name: "externalDown" });
  },
  recover: async (ctx) => {
    const client = requireToxiproxy(ctx);
    await client.startProxy(PROXY_NAME);
    ctx.trace.note("externalDown recovered");
  },
};

function requireToxiproxy(ctx: ChaosContext) {
  const client = ctx.session.toxiproxyClient;
  if (!client) throw new Error("external faults require toxiproxy; run `npm run chaos:fetch-tools`");
  return client;
}

export const processFaultDefinitions: FaultDefinition[] = [killWorker, pauseWorker];
export const externalFaultDefinitions: FaultDefinition[] = [externalLatency, externalDisconnect, externalDown];
export const allFaultDefinitions: FaultDefinition[] = [...processFaultDefinitions, ...externalFaultDefinitions];
