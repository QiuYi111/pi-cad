import fc from "fast-check";
import type { ActionDefinition, ChaosContext, Params } from "../types.ts";
import type { Snapshot } from "../sut/server.ts";

export function pickByIndex<T>(items: T[], index: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[((index % items.length) + items.length) % items.length];
}

export const isTerminalState = (state: string) => ["COMPLETED", "FAILED", "CANCELED"].includes(state);

/** Prefer entities that can actually satisfy the action, then fall back to all. */
export function pickRun<T extends { state: string; activeWorkers: string[] }>(
  runs: T[],
  index: number,
  predicate?: (run: T) => boolean,
): T | undefined {
  const preferred = predicate ? runs.filter(predicate) : runs;
  return pickByIndex(preferred.length > 0 ? preferred : runs, index);
}

export function runIndexParams(): fc.Arbitrary<Params> {
  return fc.record({ runIndex: fc.integer({ min: 0, max: 3 }) });
}

async function withSnapshot<T>(
  ctx: ChaosContext,
  handler: (snapshot: Snapshot) => Promise<T> | T,
): Promise<T | undefined> {
  const snapshot = await ctx.session.snapshot();
  return handler(snapshot);
}

function guarded(name: string, action: (ctx: ChaosContext) => Promise<void>): (ctx: ChaosContext) => Promise<void> {
  return async (ctx) => {
    try {
      await action(ctx);
    } catch (error) {
      ctx.trace.note(`${name} failed`, (error as Error).message);
    }
  };
}

export const createProject: ActionDefinition = {
  name: "createProject",
  description: "创建一个 project",
  arbitrary: fc.constant<Params>({}),
  describe: () => "createProject",
  run: guarded("createProject", async (ctx) => {
    const { projectId } = await ctx.session.client.createProject();
    ctx.trace.record({ kind: "command", name: "createProject", detail: { projectId } });
  }),
};

export const createRun: ActionDefinition = {
  name: "createRun",
  description: "在已有 project 上创建一个 run",
  arbitrary: fc.record({ projectIndex: fc.integer({ min: 0, max: 2 }) }),
  describe: (params) => `createRun(project#${params.projectIndex})`,
  run: guarded("createRun", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      // A run needs a project; bootstrap one so generated sequences do not
      // stall on an empty workspace.
      const project =
        pickByIndex(snapshot.projects, Number(ctx.params.projectIndex ?? 0)) ??
        (await ctx.session.client.createProject().then(({ projectId }) => ({ id: projectId })));
      const { runId } = await ctx.session.client.createRun(project.id);
      ctx.session.history.createdRuns += 1;
      ctx.trace.record({ kind: "command", name: "createRun", detail: { runId, projectId: project.id } });
    });
  }),
};

export const startWorker: ActionDefinition = {
  name: "startWorker",
  description: "启动 run 的 worker",
  arbitrary: runIndexParams(),
  describe: (params) => `startWorker(run#${params.runIndex})`,
  run: guarded("startWorker", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0), (candidate) => !isTerminalState(candidate.state));
      if (!run) {
        ctx.trace.note("startWorker skipped: no run");
        return;
      }
      await ctx.session.client.startRun(run.id);
      ctx.trace.record({ kind: "command", name: "startWorker", detail: { runId: run.id } });
    });
  }),
};

export const stopWorker: ActionDefinition = {
  name: "stopWorker",
  description: "停止 run（正常停止）",
  arbitrary: runIndexParams(),
  describe: (params) => `stopWorker(run#${params.runIndex})`,
  run: guarded("stopWorker", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0), (candidate) => candidate.activeWorkers.length > 0);
      if (!run) return;
      await ctx.session.client.stopRun(run.id);
      ctx.trace.record({ kind: "command", name: "stopWorker", detail: { runId: run.id } });
    });
  }),
};

export const cancelRun: ActionDefinition = {
  name: "cancelRun",
  description: "强制取消 run",
  arbitrary: runIndexParams(),
  describe: (params) => `cancelRun(run#${params.runIndex})`,
  run: guarded("cancelRun", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0), (candidate) => candidate.activeWorkers.length > 0);
      if (!run) return;
      await ctx.session.client.cancelRun(run.id);
      ctx.trace.record({ kind: "command", name: "cancelRun", detail: { runId: run.id } });
    });
  }),
};

export const restartWorker: ActionDefinition = {
  name: "restartWorker",
  description: "重启 run 的 worker",
  arbitrary: runIndexParams(),
  describe: (params) => `restartWorker(run#${params.runIndex})`,
  run: guarded("restartWorker", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0), (candidate) => candidate.activeWorkers.length > 0);
      if (!run) return;
      await ctx.session.client.stopRun(run.id).catch(() => undefined);
      await ctx.session.waitQuiescent(1_000);
      const after = await ctx.session.snapshot();
      const current = after.runs.find((candidate) => candidate.id === run.id);
      if (current && current.state !== "CANCELED") return;
      const { runId, created } = await ctx.session.client.continueRun(run.id);
      if (created) ctx.session.history.createdRuns += 1;
      ctx.trace.record({ kind: "command", name: "restartWorker", detail: { runId } });
    });
  }),
};

export const refreshRun: ActionDefinition = {
  name: "refresh",
  description: "用户刷新界面",
  arbitrary: runIndexParams(),
  describe: (params) => `refresh(run#${params.runIndex})`,
  run: guarded("refresh", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0));
      if (!run) return;
      await ctx.session.client.refreshRun(run.id).catch(() => undefined);
      await ctx.session.client.uiState(run.id).catch(() => undefined);
      ctx.trace.record({ kind: "command", name: "refresh", detail: { runId: run.id } });
    });
  }),
};

export const continueRun: ActionDefinition = {
  name: "continueRun",
  description: "用户继续任务（可能产生新的 run）",
  arbitrary: runIndexParams(),
  describe: (params) => `continueRun(run#${params.runIndex})`,
  run: guarded("continueRun", async (ctx) => {
    await withSnapshot(ctx, async (snapshot) => {
      const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0));
      if (!run) return;
      const result = await ctx.session.client.continueRun(run.id);
      if (result.created) ctx.session.history.createdRuns += 1;
      ctx.trace.record({ kind: "command", name: "continueRun", detail: result });
    });
  }),
};

export const clearFaults: ActionDefinition = {
  name: "clearFaults",
  description: "清除当前所有注入的故障",
  arbitrary: fc.constant<Params>({}),
  describe: () => "clearFaults",
  run: async (ctx) => {
    await ctx.session.faults.recoverAll(ctx.trace);
    ctx.trace.record({ kind: "command", name: "clearFaults" });
  },
};

export const settle: ActionDefinition = {
  name: "settle",
  description: "等待系统稳定",
  arbitrary: fc.record({ ms: fc.integer({ min: 80, max: 400 }) }),
  describe: (params) => `settle(${params.ms}ms)`,
  run: async (ctx) => {
    const ms = Number(ctx.params.ms ?? 150);
    await new Promise((resolve) => setTimeout(resolve, ms));
    ctx.trace.record({ kind: "command", name: "settle", detail: { ms } });
  },
};

export const actionDefinitions: ActionDefinition[] = [
  createProject,
  createRun,
  startWorker,
  stopWorker,
  cancelRun,
  restartWorker,
  refreshRun,
  continueRun,
  clearFaults,
  settle,
];
