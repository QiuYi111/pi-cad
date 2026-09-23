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
      // A run state file the harness itself is holding broken is our damage,
      // not a product defect.
      if (conversation.runId !== null && session.harnessDamage.runs.has(conversation.runId)) continue;
      if (conversation.runId !== null && !conversation.runPresent) {
        throw new InvariantViolation("run-ownership", `会话 ${conversation.id} 绑定 ${conversation.runId}，但 run 不在 store 里`, conversation);
      }
    }
    const boundTo = new Map<string, string[]>();
    for (const conversation of snapshot.conversations) {
      if (!conversation.runId) continue;
      if (session.harnessDamage.runs.has(conversation.runId)) continue;
      boundTo.set(conversation.runId, [...(boundTo.get(conversation.runId) ?? []), conversation.id]);
    }
    for (const run of snapshot.runs) {
      if (session.harnessDamage.runs.has(run.id)) continue;
      const owners = boundTo.get(run.id) ?? [];
      // Two conversations claiming one run is always wrong.
      if (owners.length > 1) {
        throw new InvariantViolation("run-ownership", `run ${run.id} 绑了 ${owners.length} 个会话（${owners.join(",") || "无"}）`, { run: run.id, owners });
      }
      // A run nobody owns is only legitimate history: the product refuses to
      // replace a run that is still active ("cad_start cannot replace active v7
      // run ... bound to this Prime conversation"), so a run really loses its
      // conversation only after it reaches a terminal state and the
      // conversation starts a fresh one. A live run with no owner is a leak.
      if (owners.length === 0 && !isTerminal(run.status)) {
        throw new InvariantViolation("run-ownership", `active run ${run.id} 没有会话绑着（status=${run.status}）`, { run: run.id, status: run.status });
      }
    }
    // A conversation keeps every run it ever started in the store as history,
    // but only one of them may still be live. Two unfinished runs under one
    // conversation is a real leak; a finished run plus its successor is just
    // how the product works (it refuses to replace a run that is still active).
    for (const [conversation, runIds] of session.history.runsByConversation) {
      const live = runIds.filter((runId) => {
        if (session.harnessDamage.runs.has(runId)) return false;
        const run = snapshot.runs.find((candidate) => candidate.id === runId);
        return run !== undefined && !isTerminal(run.status);
      });
      if (live.length > 1) {
        throw new InvariantViolation("run-ownership", `会话 ${conversation} 同时有 ${live.length} 个没结束的 run：${live.join(", ")}`, { conversation, runs: live });
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
      // Same rule as run-ownership / artifact-integrity: a run whose state file
      // the harness itself is holding broken is our damage, not a product
      // verdict. Judging it here reported "到过 done，现在又是 active" purely
      // because the harness had just truncated that same file.
      if (session.harnessDamage.runs.has(run.id)) continue;
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
  async check({ session, snapshot }) {
    for (const run of snapshot.runs) {
      if (session.harnessDamage.runs.has(run.id)) continue;
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
    // A round injects several faults on purpose and recovers them all after the
    // sequence has run (race scenarios need the fault to stay armed across the
    // following steps). So "how long has this fault been armed" is not a
    // failure signal — a 3-minute round would trip it while every step was
    // making real progress. The clock only starts once the harness has really
    // asked for recovery; from there, a fault that is still armed past the
    // budget is a hang.
    const recoveryStartedAt = session.history.recoveryStartedAt;
    if (recoveryStartedAt === undefined) return;
    for (const [fault, at] of session.history.armedSince) {
      if (now - recoveryStartedAt < RECOVERY_BUDGET_MS) continue;
      if (session.history.recoveries.some((recovery) => recovery.at > at)) continue;
      // A fault whose own recovery really ran (and proved itself) counts as
      // convergence even when its proof is not a build, e.g. the credential
      // copy going back to a usable state.
      if (
        session.faultOutcomes.some(
          (outcome) => outcome.name === fault && outcome.phase === "recover" && outcome.status === "Recovered" && outcome.at > at,
        )
      ) {
        continue;
      }
      throw new InvariantViolation(
        "recovery-convergence",
        `要求恢复已经 ${now - recoveryStartedAt}ms，故障 ${fault} 还挂着`,
        { fault, armedAt: at, recoveryStartedAt },
      );
    }
  },
};

/**
 * Fault semantics must stay honest: a fault may only be "not applicable" when
 * a real-state decision said so, with a reason. An `InjectionFailed` outcome
 * means the real system threw where the fault expected to act; the runner
 * turns that into a failure, and this invariant makes sure it can never be
 * recorded and then quietly ignored.
 */
const faultOutcomeHonest: ReifyInvariantDefinition = {
  name: "fault-outcome-honest",
  description: "fault 结果必须有明确语义：不适用要给理由，注入失败不能被吞",
  async check({ session }) {
    for (const outcome of session.faultOutcomes) {
      if (outcome.status === "NotApplicable" && !outcome.reason) {
        throw new InvariantViolation("fault-outcome-honest", `fault ${outcome.name} 判成不适用但没给理由`, outcome);
      }
      if (outcome.status === "InjectionFailed") {
        throw new InvariantViolation("fault-outcome-honest", `fault ${outcome.name} 注入失败：${outcome.reason ?? "没有原因"}`, outcome);
      }
    }
  },
};

export const reifyInvariantDefinitions: ReifyInvariantDefinition[] = [
  noOrphanKernel,
  runOwnership,
  terminalStateStable,
  artifactIntegrity,
  recoveryConvergence,
  faultOutcomeHonest,
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
