import { ACTIVE_WORKER_STATUSES, isTerminal } from "../sut/server.ts";
import { isProcessAlive } from "../sut/proc.ts";
import { InvariantViolation, type InvariantContext, type InvariantDefinition } from "../types.ts";

/** A worker record may lag a real exit by a few ms; ignore shorter gaps. */
const DEAD_WORKER_GRACE_MS = Number(process.env.CHAOS_DEAD_WORKER_GRACE_MS ?? 400);
/** A run must not sit in a non-terminal state without a live worker. */
const STALLED_RUN_BUDGET_MS = Number(process.env.CHAOS_STALLED_RUN_BUDGET_MS ?? 2_500);

/** 同一个 run 同时最多一个 active worker。 */
const singleActiveWorker: InvariantDefinition = {
  name: "single-active-worker",
  description: "同一个 run 同时最多一个 active worker",
  async check({ snapshot }) {
    for (const run of snapshot.runs) {
      if (run.activeWorkers.length > 1) {
        throw new InvariantViolation(
          "single-active-worker",
          `run ${run.id} 有 ${run.activeWorkers.length} 个 active worker: ${run.activeWorkers.join(", ")}`,
          { run: run.id, activeWorkers: run.activeWorkers },
        );
      }
    }
  },
};

/** worker 记录说自己在跑，进程就必须真的活着。 */
const workerLiveness: InvariantDefinition = {
  name: "worker-liveness",
  description: "active worker 的进程必须还活着",
  async check({ session, snapshot, now }) {
    const seen = new Set<string>();
    for (const worker of snapshot.workers) {
      if (!ACTIVE_WORKER_STATUSES.includes(worker.status)) continue;
      seen.add(worker.id);
      if (isProcessAlive(worker.pid)) {
        session.history.deadWorkerSince.delete(worker.id);
        continue;
      }
      const since = session.history.deadWorkerSince.get(worker.id) ?? now;
      session.history.deadWorkerSince.set(worker.id, since);
      if (now - since > DEAD_WORKER_GRACE_MS) {
        throw new InvariantViolation(
          "worker-liveness",
          `worker ${worker.id} 状态是 ${worker.status}，但 pid ${worker.pid} 已经不存在`,
          { worker: worker.id, runId: worker.runId, status: worker.status, pid: worker.pid, deadForMs: now - since },
        );
      }
    }
    for (const workerId of [...session.history.deadWorkerSince.keys()]) {
      if (!seen.has(workerId)) session.history.deadWorkerSince.delete(workerId);
    }
  },
};

/** worker 的 run 归属不能串到别的 run。 */
const workerOwnership: InvariantDefinition = {
  name: "worker-ownership",
  description: "active worker 必须就是它 run 当前的 worker",
  async check({ snapshot }) {
    const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
    for (const worker of snapshot.workers) {
      if (!ACTIVE_WORKER_STATUSES.includes(worker.status)) continue;
      const run = runs.get(worker.runId);
      if (!run) {
        throw new InvariantViolation(
          "worker-ownership",
          `worker ${worker.id} 指向不存在的 run ${worker.runId}`,
          { worker: worker.id, runId: worker.runId },
        );
      }
      if (run.workerId !== worker.id) {
        throw new InvariantViolation(
          "worker-ownership",
          `worker ${worker.id} 仍算 active，但 run ${run.id} 当前 worker 是 ${run.workerId}`,
          { worker: worker.id, runId: run.id, runWorkerId: run.workerId },
        );
      }
    }
  },
};

/** terminal state 不能回到 RUNNING。 */
const terminalStateStable: InvariantDefinition = {
  name: "terminal-state-stable",
  description: "terminal state 不能回到非 terminal",
  async check({ session, snapshot }) {
    for (const run of snapshot.runs) {
      if (isTerminal(run.state)) session.history.terminalSeen.add(run.id);
      else if (session.history.terminalSeen.has(run.id)) {
        throw new InvariantViolation(
          "terminal-state-stable",
          `run ${run.id} 到过 terminal，现在又变成 ${run.state}`,
          { run: run.id, state: run.state },
        );
      }
    }
  },
};

/** worker 崩了以后必须收敛，不能一直挂在 STARTING / RUNNING / STOPPING。 */
const recoveryConvergence: InvariantDefinition = {
  name: "recovery-convergence",
  description: "没有 live worker 的 run 不能一直停在非 terminal 状态",
  async check({ session, snapshot, now }) {
    const stalled = new Set<string>();
    for (const run of snapshot.runs) {
      if (isTerminal(run.state)) continue;
      if (run.state === "PENDING") continue;
      const live = snapshot.workers.some(
        (worker) =>
          worker.runId === run.id && ACTIVE_WORKER_STATUSES.includes(worker.status) && isProcessAlive(worker.pid),
      );
      if (live) continue;
      stalled.add(run.id);
      const since = session.history.stalledRunSince.get(run.id) ?? now;
      session.history.stalledRunSince.set(run.id, since);
      if (now - since > STALLED_RUN_BUDGET_MS) {
        throw new InvariantViolation(
          "recovery-convergence",
          `run ${run.id} 停在 ${run.state} 且没有 live worker，已 ${now - since}ms`,
          { run: run.id, state: run.state, stalledForMs: now - since, crashedWorkers: run.crashedWorkers },
        );
      }
    }
    for (const runId of [...session.history.stalledRunSince.keys()]) {
      if (!stalled.has(runId)) session.history.stalledRunSince.delete(runId);
    }
  },
};

/** UI 显示的关键状态必须和 backend 一致。 */
const uiBackendConsistency: InvariantDefinition = {
  name: "ui-backend-consistency",
  description: "UI 状态投影必须等于 backend 状态",
  async check({ snapshot }) {
    for (const run of snapshot.runs) {
      if (run.ui.status !== run.state) {
        throw new InvariantViolation(
          "ui-backend-consistency",
          `run ${run.id} UI 显示 ${run.ui.status}，backend 是 ${run.state}`,
          { run: run.id, ui: run.ui.status, backend: run.state },
        );
      }
      const expectedActive = run.activeWorkers.length > 0;
      if (run.ui.workerActive !== expectedActive) {
        throw new InvariantViolation(
          "ui-backend-consistency",
          `run ${run.id} UI workerActive=${run.ui.workerActive} 与 active worker 数 ${run.activeWorkers.length} 不一致`,
          { run: run.id, ui: run.ui, activeWorkers: run.activeWorkers },
        );
      }
    }
  },
};

/** 同一个用户动作不能产生重复副作用。 */
const noDuplicateEffects: InvariantDefinition = {
  name: "no-duplicate-effects",
  description: "同一个 step token 只能产生一次副作用",
  async check({ snapshot }) {
    for (const run of snapshot.runs) {
      const counts = new Map<string, number>();
      for (const token of run.effectTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const [token, count] of counts) {
        if (count > 1) {
          throw new InvariantViolation(
            "no-duplicate-effects",
            `run ${run.id} 的 token ${token} 产生了 ${count} 次副作用`,
            { run: run.id, token, count, effectTokens: run.effectTokens },
          );
        }
      }
    }
  },
};

/** 不能让系统自己凭空多出 run（外部故障后重复创建）。 */
const noUnexpectedRuns: InvariantDefinition = {
  name: "no-unexpected-runs",
  description: "backend 里的 run 不能多于实际创建的次数",
  async check({ session, snapshot }) {
    if (snapshot.runs.length > session.history.createdRuns) {
      throw new InvariantViolation(
        "no-unexpected-runs",
        `创建了 ${session.history.createdRuns} 个 run，backend 却有 ${snapshot.runs.length} 个`,
        { created: session.history.createdRuns, runs: snapshot.runs.map((run) => run.id) },
      );
    }
  },
};

export const invariantDefinitions: InvariantDefinition[] = [
  workerOwnership,
  workerLiveness,
  singleActiveWorker,
  terminalStateStable,
  recoveryConvergence,
  uiBackendConsistency,
  noDuplicateEffects,
  noUnexpectedRuns,
];

export async function checkInvariants(ctx: InvariantContext): Promise<void> {
  for (const invariant of invariantDefinitions) {
    await invariant.check(ctx);
  }
}
