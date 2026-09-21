import { InvariantViolation } from "../types.ts";
import { TERMINAL_RUN_STATUSES, type ReifySession, type ReifySnapshot } from "./session.ts";
import type { ReifyTrace } from "./trace.ts";
import type { ReifyInvariantContext, ReifyInvariantDefinition } from "./types.ts";

const RECOVERY_BUDGET_MS = Number(process.env.CHAOS_REIFY_RECOVERY_BUDGET_MS ?? 90_000);

const isTerminal = (status: string): boolean => (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/**
 * 控制面死了，它起的 kernel 不能还活着。
 * 真的 crash 会留下孤儿 CAD 进程，占着内存和 CPU，下一轮又起新 kernel。
 */
const noOrphanKernel: ReifyInvariantDefinition = {
  name: "no-orphan-kernel",
  description: "控制面进程死了以后，它起的 kernel 不能继续跑",
  async check({ session, now }) {
    const orphans = session.orphanKernels(now);
    if (!orphans.length) return;
    throw new InvariantViolation(
      "no-orphan-kernel",
      `${orphans.length} 个 kernel 的父控制面已经死了，进程还在：${orphans.map((k) => `${k.pid}(owner=${k.ownerPid})`).join(", ")}`,
      {
        orphans: orphans.map((kernel) => ({
          pid: kernel.pid,
          ownerPid: kernel.ownerPid,
          sinceMs: now - (session.history.orphanSince.get(kernel.pid) ?? now),
        })),
      },
    );
  },
};

/** run 归属：会话绑定的 run 必须真存在，一个 run 只能属于一个会话。 */
const runOwnership: ReifyInvariantDefinition = {
  name: "run-ownership",
  description: "会话和 run 的绑定必须真实且唯一",
  async check({ session, snapshot }) {
    for (const conversation of snapshot.conversations) {
      if (conversation.runId !== null && !conversation.runPresent) {
        throw new InvariantViolation("run-ownership", `会话 ${conversation.id} 绑定 ${conversation.runId}，但 run 不在 store 里`, conversation);
      }
    }
    const boundTo = new Map<string, string[]>();
    for (const conversation of snapshot.conversations) {
      if (!conversation.runId) continue;
      boundTo.set(conversation.runId, [...(boundTo.get(conversation.runId) ?? []), conversation.id]);
    }
    for (const run of snapshot.runs) {
      const owners = boundTo.get(run.id) ?? [];
      if (owners.length !== 1) {
        throw new InvariantViolation("run-ownership", `run ${run.id} 绑了 ${owners.length} 个会话（${owners.join(",") || "无"}）`, { run: run.id, owners });
      }
    }
    // Every run this conversation ever started must still be the only run it owns.
    for (const [conversation, runIds] of session.history.runsByConversation) {
      const present = runIds.filter((runId) => snapshot.runs.some((run) => run.id === runId));
      if (present.length > 1) {
        throw new InvariantViolation("run-ownership", `会话 ${conversation} 有 ${present.length} 个 run：${present.join(", ")}`, { conversation, runs: present });
      }
    }
  },
};

/** terminal run 不能往回走。 */
const terminalStateStable: ReifyInvariantDefinition = {
  name: "terminal-state-stable",
  description: "terminal run 不能回到非 terminal",
  async check({ session, snapshot }) {
    for (const run of snapshot.runs) {
      if (isTerminal(run.status)) {
        session.history.runStatus.set(run.id, run.status);
        continue;
      }
      const seen = session.history.runStatus.get(run.id);
      if (seen && isTerminal(seen)) {
        throw new InvariantViolation("terminal-state-stable", `run ${run.id} 到过 ${seen}，现在又是 ${run.status}`, { run: run.id, seen, now: run.status });
      }
    }
  },
};

/** run 里记的 artifact 必须真在盘上，hash 必须对上。 */
const artifactIntegrity: ReifyInvariantDefinition = {
  name: "artifact-integrity",
  description: "run 记录的 artifact 必须真存在且 hash 一致，且候选件只有一份",
  async check({ snapshot }) {
    for (const run of snapshot.runs) {
      const candidates = run.artifacts.filter((artifact) => artifact.id === "candidate:authoritative");
      if (candidates.length > 1) {
        throw new InvariantViolation("artifact-integrity", `run ${run.id} 有 ${candidates.length} 份 candidate:authoritative`, { run: run.id });
      }
      for (const artifact of run.artifacts) {
        if (artifact.sha256OnDisk === artifact.sha256) continue;
        throw new InvariantViolation(
          "artifact-integrity",
          `run ${run.id} 记的 ${artifact.path} 和盘上不一致（记录 ${artifact.sha256.slice(0, 12)}，盘上 ${
            artifact.sha256OnDisk ? artifact.sha256OnDisk.slice(0, 12) : "缺失"
          }）`,
          { run: run.id, artifact: artifact.id, path: artifact.path },
        );
      }
    }
  },
};

/** 灌了故障以后，运行中的 run 不能在预算内一直没人管。 */
const recoveryConvergence: ReifyInvariantDefinition = {
  name: "recovery-convergence",
  description: "注入故障后必须在预算内由真 build 恢复",
  async check({ session, now }) {
    for (const [fault, at] of session.history.armedSince) {
      if (now - at < RECOVERY_BUDGET_MS) continue;
      if (session.history.recoveries.some((recovery) => recovery.at > at)) continue;
      throw new InvariantViolation(
        "recovery-convergence",
        `故障 ${fault} 注入 ${now - at}ms 后还没恢复`,
        { fault, armedAt: at },
      );
    }
  },
};

export const reifyInvariantDefinitions: ReifyInvariantDefinition[] = [
  noOrphanKernel,
  runOwnership,
  terminalStateStable,
  artifactIntegrity,
  recoveryConvergence,
];

export async function checkReifyInvariants(input: { session: ReifySession; snapshot: ReifySnapshot; now: number }): Promise<void> {
  for (const invariant of reifyInvariantDefinitions) {
    await invariant.check(input);
  }
}

export async function checkInvariantsOn(session: ReifySession, trace: ReifyTrace, label: string): Promise<ReifySnapshot> {
  const snapshot = await session.snapshot();
  trace.observe(snapshot, label);
  await checkReifyInvariants({ session, snapshot, now: Date.now() });
  return snapshot;
}
