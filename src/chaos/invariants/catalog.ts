import type { JsonValue } from "../../harness/canonical.ts";
import { InvariantViolationError, type ReifyInvariantDefinition } from "./types.ts";

/** Statuses Reify treats as settled. Nothing may leave them without a new run. */
export const TERMINAL_RUN_STATUSES = ["done", "aborted", "blocked_user", "blocked_external", "budget_exhausted"] as const;
/** Statuses a live runtime owns and must keep advancing. */
export const LIVE_RUN_STATUSES = ["active", "ready"] as const;
/** Statuses that must explain themselves with a blocker. */
export const BLOCKER_REQUIRED_STATUSES = ["blocked_user", "blocked_external"] as const;

const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);
const LIVE = new Set<string>(LIVE_RUN_STATUSES);
const BLOCKER_REQUIRED = new Set<string>(BLOCKER_REQUIRED_STATUSES);

export const ORPHAN_GRACE_MS = Number(process.env.CHAOS_INVARIANT_ORPHAN_GRACE_MS ?? 2_000);
export const RECOVERY_BUDGET_MS = Number(process.env.CHAOS_INVARIANT_RECOVERY_BUDGET_MS ?? 90_000);
export const RUNTIME_STALL_BUDGET_MS = Number(process.env.CHAOS_INVARIANT_RUNTIME_STALL_MS ?? 120_000);
export const UNPUBLISHED_TRANSACTION_GRACE_MS = Number(process.env.CHAOS_INVARIANT_UNPUBLISHED_GRACE_MS ?? 300_000);
export const PROJECTION_GRACE_MS = Number(process.env.CHAOS_INVARIANT_PROJECTION_GRACE_MS ?? 30_000);

function violate(definition: ReifyInvariantDefinition, detail: string, evidence: Record<string, JsonValue>): never {
  throw new InvariantViolationError({
    name: definition.name,
    severity: definition.severity,
    scope: definition.scope,
    detail,
    evidence,
  });
}

function terminalRunLabel(status: string): boolean {
  return TERMINAL.has(status);
}

/**
 * Every run directory, its project listing, and its own state must agree on
 * the run identity. A run that answers to two identities makes every later
 * ownership and artifact check meaningless.
 */
const runIdentityUnique: ReifyInvariantDefinition = {
  name: "run-identity-unique",
  severity: "P0",
  scope: "session-run-isolation",
  title: "一个 run 只有一个身份",
  why: "run 目录名、project 记录、state.runId 必须同一个值，否则 run 归属和 artifact 都会串。",
  stateSources: ["v7-project/state.json", "runs/<runId>/state.json"],
  graceMs: 0,
  check({ project }) {
    const duplicates = project.listedRunIds.filter((runId, index) => project.listedRunIds.indexOf(runId) !== index);
    if (duplicates.length) violate(runIdentityUnique, `project 把同一个 run 记了多次：${[...new Set(duplicates)].join(", ")}`, { duplicates: [...new Set(duplicates)] });
    for (const run of project.runs) {
      if (!run.state) continue;
      if (run.state.runId !== run.runId) {
        violate(runIdentityUnique, `目录 ${run.runId} 里的 state.runId 是 ${run.state.runId}`, { directory: run.directory, declared: run.runId, stored: run.state.runId });
      }
    }
  },
};

/**
 * The project pointers are the only selection authority. They must always
 * resolve to a real run, and a promoted run must be the run that produced
 * Project Head.
 */
const projectRunReferenceIntegrity: ReifyInvariantDefinition = {
  name: "project-run-reference-integrity",
  severity: "P0",
  scope: "session-run-isolation",
  title: "project 指针必须指向真 run",
  why: "currentRunId / promotedRunId / head.artifacts 指向不存在的 run 时，界面会显示一个已经不存在的 run。",
  stateSources: ["v7-project/state.json", "runs/<runId>/state.json"],
  graceMs: 0,
  check({ project }) {
    if (!project.projectState) return;
    const present = new Set(project.presentRunIds);
    const runs = new Map(project.runs.map((run) => [run.runId, run]));
    const { currentRunId, promotedRunId } = project.projectState;
    if (currentRunId && !present.has(currentRunId)) {
      violate(projectRunReferenceIntegrity, `currentRunId ${currentRunId} 没有 run 目录`, { currentRunId, present: project.presentRunIds });
    }
    if (promotedRunId) {
      const promoted = runs.get(promotedRunId);
      if (!promoted?.state) violate(projectRunReferenceIntegrity, `promotedRunId ${promotedRunId} 不在 store 里`, { promotedRunId });
      else {
        if (!terminalRunLabel(promoted.state.status)) {
          violate(projectRunReferenceIntegrity, `promoted run ${promotedRunId} 的状态是 ${promoted.state.status}`, { promotedRunId, status: promoted.state.status });
        }
        const head = project.projectState.head.artifacts;
        const expected = promoted.state.artifacts;
        const headIds = Object.keys(head).sort();
        const expectedIds = Object.keys(expected).sort();
        const mismatched = headIds.length !== expectedIds.length || headIds.some((id, index) => id !== expectedIds[index] || head[id]!.sha256 !== expected[id]!.sha256);
        if (mismatched) {
          violate(projectRunReferenceIntegrity, `Project Head 的 artifact 和 promoted run 不一致`, {
            promotedRunId,
            head: headIds.map((id) => ({ id, sha256: head[id]!.sha256 })),
            run: expectedIds.map((id) => ({ id, sha256: expected[id]!.sha256 })),
          });
        }
      }
    }
  },
};

/**
 * The published generation must be a complete, verifiable transaction chain.
 * A torn generation is how a crash turns into invisible corruption.
 */
const transactionHeadConsistent: ReifyInvariantDefinition = {
  name: "transaction-head-consistent",
  severity: "P0",
  scope: "recovery",
  title: "已发布的 generation 必须是完整可验证的链",
  why: "HEAD、commit、manifest、payload 任一 hash 对不上，说明这一代是撕裂的，读出来的状态不可信。",
  stateSources: ["<store>/HEAD", "<store>/transactions/<txId>/{commit,manifest}.json", "<store>/transactions/<txId>/<payload>"],
  graceMs: UNPUBLISHED_TRANSACTION_GRACE_MS,
  check({ project, graceMs }) {
    const stores: Array<{ label: string; errors: string[]; headError: string | null; unpublished: Array<{ txId: string; ageMs: number }> }> = [
      { label: "v7-project", errors: project.projectTransactionErrors, headError: project.projectHeadError, unpublished: project.unpublishedTransactions },
      ...project.runs.map((run) => ({ label: `runs/${run.runId}`, errors: [...run.transactionErrors, ...(run.headError ? [run.headError] : [])], headError: null, unpublished: run.unpublishedTransactions })),
    ];
    for (const store of stores) {
      if (store.headError) violate(transactionHeadConsistent, `${store.label} 的 HEAD 不可读：${store.headError}`, { store: store.label });
      if (store.errors.length) violate(transactionHeadConsistent, `${store.label} 的 generation 链断了：${store.errors[0]}`, { store: store.label, errors: store.errors.slice(0, 8) });
      const stale = store.unpublished.filter((item) => item.ageMs > graceMs);
      if (stale.length) {
        violate(transactionHeadConsistent, `${store.label} 有 ${stale.length} 个只写了一半的 generation`, { store: store.label, unpublished: stale.map((item) => ({ txId: item.txId, ageMs: item.ageMs })) });
      }
    }
  },
};

/**
 * What a reader sees must be byte-identical to the published generation, and
 * `events.jsonl` must publish each generation exactly once. This is the
 * boundary between "the crash left a stale file" and "the run advanced".
 */
const stateMaterializationConsistent: ReifyInvariantDefinition = {
  name: "state-materialization-consistent",
  severity: "P0",
  scope: "recovery",
  title: "读到的 state 必须等于已发布的 generation",
  why: "materialize 落后或 events.jsonl 行数不对，说明恢复只做了一半，读到的是旧状态。",
  stateSources: ["v7-project/state.json", "<store>/HEAD", "<store>/events.jsonl", "<store>/transactions/<txId>/state.json"],
  graceMs: 0,
  check({ project }) {
    const check = (label: string, generation: number | null, materialized: string | null, published: string | null, eventLines: number) => {
      if (generation === null) return;
      if (published !== null && materialized !== published) {
        violate(stateMaterializationConsistent, `${label} 的 state.json 不是已发布的 generation`, { store: label, materialized, published });
      }
      if (eventLines !== generation) {
        violate(stateMaterializationConsistent, `${label} 的 events.jsonl 有 ${eventLines} 行，generation 是 ${generation}`, { store: label, eventLines, generation });
      }
    };
    check("v7-project", project.projectHeadGeneration, project.projectMaterializedStateSha256, project.projectHeadStateSha256, project.projectEventLineCount);
    for (const run of project.runs) {
      check(`runs/${run.runId}`, run.headGeneration, run.materializedStateSha256, run.headStateSha256, run.eventLineCount);
    }
  },
};

/**
 * Terminal is terminal. A run that went done/aborted/blocked must never be
 * published as active again, and the project must not keep selecting one.
 */
const terminalStateStable: ReifyInvariantDefinition = {
  name: "terminal-state-stable",
  severity: "P0",
  scope: "runtime-lifecycle",
  title: "终态不能回到活动态",
  why: "终态回退会让 stop / cancel 失效，旧 run 继续产生副作用。",
  stateSources: ["runs/<runId>/transactions/<txId>/state.json", "v7-project/state.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      let settled: { generation: number; status: string } | null = null;
      for (const step of run.statusTimeline) {
        if (terminalRunLabel(step.status)) settled = { generation: step.generation, status: step.status };
        else if (settled) {
          violate(terminalStateStable, `run ${run.runId} 第 ${settled.generation} 代是 ${settled.status}，第 ${step.generation} 代又成了 ${step.status}`, {
            run: run.runId,
            settledGeneration: settled.generation,
            settledStatus: settled.status,
            observedGeneration: step.generation,
            observedStatus: step.status,
          });
        }
      }
    }
  },
};

/**
 * A run that reached a terminal phase through a transition is only
 * deselected when the next `cad_start` reconciles it. If it stays selected
 * past the recovery budget, the reconcile never ran.
 */
const settledRunNotReconciled: ReifyInvariantDefinition = {
  name: "settled-run-not-reconciled",
  severity: "P1",
  scope: "recovery",
  title: "终态 run 不能在 project 里一直挂着",
  why: "终态 run 还占着 currentRunId，说明 reconcile 没跑，下一个 run 起来时状态是脏的。",
  stateSources: ["v7-project/state.json", "runs/<runId>/state.json", "runs/<runId>/HEAD"],
  graceMs: RECOVERY_BUDGET_MS,
  budgetMs: RECOVERY_BUDGET_MS,
  check({ project, graceMs }) {
    const currentRunId = project.projectState?.currentRunId;
    if (!currentRunId) return;
    const run = project.runs.find((item) => item.runId === currentRunId);
    if (!run?.state || !terminalRunLabel(run.state.status)) return;
    if (run.advanceAgeMs !== null && run.advanceAgeMs <= graceMs) return;
    violate(settledRunNotReconciled, `终态 run ${currentRunId}（${run.state.status}）还占着 currentRunId`, {
      currentRunId,
      status: run.state.status,
      idleMs: run.advanceAgeMs,
      budgetMs: graceMs,
    });
  },
};

/**
 * Recorded artifacts are a promise. The bytes must be on disk at the recorded
 * path with the recorded hash, and a run must have exactly one authoritative
 * candidate.
 */
const artifactIntegrity: ReifyInvariantDefinition = {
  name: "artifact-integrity",
  severity: "P0",
  scope: "side-effect-artifact",
  title: "记录里的 artifact 必须存在且 hash 一致",
  why: "state 记了 artifact 但盘上没有或 hash 变了，后面所有 review、delivery 都建立在假事实上。",
  stateSources: ["runs/<runId>/state.json", "project 工作区文件", "<store>/transactions/<txId>/evidence/**", "<store>/transactions/<txId>/records/**"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      if (!run.state) continue;
      const authoritative = run.artifacts.filter((item) => item.id === "candidate:authoritative");
      if (authoritative.length > 1) {
        violate(artifactIntegrity, `run ${run.runId} 有 ${authoritative.length} 份 candidate:authoritative`, { run: run.runId, ids: authoritative.map((item) => item.id) });
      }
      for (const observation of [...run.artifacts, ...run.evidence, ...run.records]) {
        if (observation.observedSha256 === null) {
          violate(artifactIntegrity, `run ${run.runId} 记的 ${observation.recordedPath} 读不出来`, {
            run: run.runId,
            id: observation.id,
            location: observation.location,
            path: observation.recordedPath,
            absolutePath: observation.absolutePath,
            digestRule: observation.digestRule,
          });
        }
        if (observation.observedSha256 !== observation.recordedSha256) {
          violate(artifactIntegrity, `run ${run.runId} 记的 ${observation.recordedPath} hash 不一致`, {
            run: run.runId,
            id: observation.id,
            location: observation.location,
            path: observation.recordedPath,
            digestRule: observation.digestRule,
            recorded: observation.recordedSha256,
            observed: observation.observedSha256,
            observedFile: observation.observedFileSha256,
          });
        }
      }
    }
    for (const observation of project.headArtifacts) {
      if (observation.observedSha256 === observation.recordedSha256) continue;
      violate(artifactIntegrity, `Project Head 的 ${observation.recordedPath} 和记录对不上`, {
        id: observation.id,
        path: observation.recordedPath,
        recorded: observation.recordedSha256,
        observed: observation.observedSha256,
      });
    }
  },
};

/**
 * A logical action commits once. The workspace commit index and the commit
 * manifests must agree one-to-one, without a repeated identity.
 */
const noDuplicateEffect: ReifyInvariantDefinition = {
  name: "no-duplicate-effect",
  severity: "P0",
  scope: "side-effect-artifact",
  title: "同一个逻辑动作只能提交一次",
  why: "同一步骤重复 commit，会让一次设计动作产生两个 effect，历史和 artifact 都对不上。",
  stateSources: ["runs/<runId>/workspace/commits/index.json", "runs/<runId>/workspace/commits/<id>.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      if (!run.materialized) continue;
      const duplicates = run.commitIndex.filter((id, index) => run.commitIndex.indexOf(id) !== index);
      if (duplicates.length) violate(noDuplicateEffect, `run ${run.runId} 的 commit index 重复记了 ${[...new Set(duplicates)].join(", ")}`, { run: run.runId, duplicates: [...new Set(duplicates)] });
      if (run.commitErrors.length) violate(noDuplicateEffect, `run ${run.runId} 的 commit 记录对不上：${run.commitErrors[0]}`, { run: run.runId, errors: run.commitErrors.slice(0, 8) });
    }
  },
};

/**
 * A weaker, still useful signal: the same step name committed from the same
 * parent twice. Reify's identity includes the phase, so this is not by itself
 * corruption; it is a quality rule that points at a repeated effect.
 */
const repeatStepCommit: ReifyInvariantDefinition = {
  name: "repeat-step-commit",
  severity: "P1",
  scope: "side-effect-artifact",
  title: "同一步骤不应该反复提交",
  why: "名字、parent 都一样的提交出现两次，往往是一次动作写了两遍，后面查历史会分不清哪次算数。",
  stateSources: ["runs/<runId>/workspace/commits/index.json", "runs/<runId>/workspace/commits/<id>.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      const identities = new Map<string, string>();
      for (const commit of run.commits) {
        const key = `${commit.name}\u0000${commit.parent ?? ""}\u0000${commit.workflowHash}`;
        const seen = identities.get(key);
        if (seen && seen !== commit.id) {
          violate(repeatStepCommit, `run ${run.runId} 用同一步骤 ${commit.name} 提交了两次`, {
            run: run.runId,
            name: commit.name,
            parent: commit.parent,
            first: seen,
            second: commit.id,
          });
        }
        identities.set(key, commit.id);
      }
    }
  },
};

/**
 * One logical run may own at most one live runtime, and never a live runtime
 * after it has settled.
 */
const singleActiveRuntimePerRun: ReifyInvariantDefinition = {
  name: "single-active-runtime-per-run",
  severity: "P0",
  scope: "runtime-lifecycle",
  title: "一个 run 最多一个活动 runtime",
  why: "两个 runtime 同时跑同一个 run，会各写一份 artifact、互相覆盖，也说不清谁的副作用算数。",
  stateSources: ["runs/<runId>/recipe-runs/<id>/record/run.json"],
  graceMs: ORPHAN_GRACE_MS,
  check({ project, graceMs }) {
    for (const run of project.runs) {
      const running = run.recipeRuns.filter((item) => item.status === "running");
      if (running.length > 1) {
        violate(singleActiveRuntimePerRun, `run ${run.runId} 同时有 ${running.length} 个 running runtime`, { run: run.runId, runtimes: running.map((item) => item.recipeRunId) });
      }
      if (run.state && terminalRunLabel(run.state.status)) {
        const stale = running.filter((item) => item.idleMs > graceMs);
        if (stale.length) {
          violate(singleActiveRuntimePerRun, `终态 run ${run.runId}（${run.state.status}）还留着 running runtime`, { run: run.runId, runtimes: stale.map((item) => ({ id: item.recipeRunId, status: item.status, idleMs: item.idleMs })) });
        }
      }
    }
  },
};

/**
 * The workspace projection may lag the authority, but it may never show a
 * different run, phase, status, or workflow snapshot than the authority has.
 */
const conversationRunBinding: ReifyInvariantDefinition = {
  name: "conversation-run-binding",
  severity: "P0",
  scope: "ui-backend",
  title: "界面投影不能和 backend 矛盾",
  why: "投影显示另一个 run 的阶段或终态，用户会以为自己的设计变了。",
  stateSources: [".pi-cad/status.json", "v7-project/state.json", "runs/<runId>/state.json"],
  graceMs: PROJECTION_GRACE_MS,
  check({ project, graceMs }) {
    if (project.projectionError) violate(conversationRunBinding, `状态投影不可解析：${project.projectionError}`, { path: project.projectionPath });
    if (!project.projection || !project.projectState || project.projectionAgeMs === null) return;
    const projection = project.projection;
    // The projection is written after the state it shows. It is allowed to be
    // older than a state change only by the grace window; a projection that is
    // newer than the state it contradicts is not lag, it is a conflict.
    const lags = (stateAgeMs: number | null) => {
      if (stateAgeMs === null) return project.projectionAgeMs! <= graceMs;
      const lag = project.projectionAgeMs! - stateAgeMs;
      return lag > 0 && lag <= graceMs;
    };
    if (projection.project.id !== project.projectState.projectId) {
      violate(conversationRunBinding, `投影的 project ${projection.project.id} 不是本项目的 ${project.projectState.projectId}`, {
        projectionId: projection.project.id,
        authoritativeId: project.projectState.projectId,
        path: project.projectionPath,
      });
    }
    // A projection that names a run this store never had belongs to a
    // different store; `projection-store-mismatch` reports that, and comparing
    // ids across stores here would only add noise.
    const known = new Set(project.runs.map((run) => run.runId));
    const referenced = [projection.project.currentRunId, projection.run?.id].filter((id): id is string => typeof id === "string");
    if (referenced.some((id) => !known.has(id))) return;
    if (projection.project.currentRunId !== project.projectState.currentRunId && !lags(project.projectAdvanceAgeMs)) {
      violate(conversationRunBinding, `投影的 currentRunId ${String(projection.project.currentRunId)} 和 backend 的 ${String(project.projectState.currentRunId)} 不一致`, {
        projection: projection.project.currentRunId,
        authoritative: project.projectState.currentRunId,
        projectionAgeMs: project.projectionAgeMs,
        graceMs,
      });
    }
    if (projection.run) {
      const bound = [project.projectState.currentRunId, project.projectState.promotedRunId].filter((id): id is string => typeof id === "string");
      if (!bound.includes(projection.run.id)) {
        violate(conversationRunBinding, `投影显示 run ${projection.run.id}，但项目没有绑定它`, { projectionRun: projection.run.id, bound });
      }
      const authoritative = project.runs.find((run) => run.runId === projection.run!.id);
      if (!authoritative?.state) {
        violate(conversationRunBinding, `投影显示的 run ${projection.run.id} 在 store 里不存在`, { projectionRun: projection.run.id });
      } else if (!lags(authoritative.advanceAgeMs)) {
        const drift = authoritative.state.status !== projection.run.status ? "status"
          : authoritative.state.phase !== projection.run.phase ? "phase"
          : authoritative.state.workflow.hash !== projection.run.workflowHash ? "workflowHash"
          : null;
        if (drift) {
          violate(conversationRunBinding, `投影的 run ${projection.run.id} 的 ${drift} 和 backend 不一致`, {
            run: projection.run.id,
            drift,
            projection: { status: projection.run.status, phase: projection.run.phase, workflowHash: projection.run.workflowHash },
            authoritative: { status: authoritative.state.status, phase: authoritative.state.phase, workflowHash: authoritative.state.workflow.hash },
          });
        }
      }
    }
  },
};

/**
 * The workspace projection and the run store must come from the same project
 * store. Reading a leftover store while the product used another one is a
 * checker setup error, not a Reify bug, and it must say so instead of
 * reporting a fake UI conflict.
 */
const projectionStoreMismatch: ReifyInvariantDefinition = {
  name: "projection-store-mismatch",
  severity: "P1",
  scope: "ui-backend",
  title: "投影和 store 必须来自同一个项目存储",
  why: "投影指向本 store 没有的 run，说明读的是别的 store 或旧 store，检查结果不可信。",
  stateSources: ["<project>/.pi-cad/status.json", "v7-project/state.json", "~/.local/share/pi-cad/<project-key>/v7-project/state.json"],
  graceMs: PROJECTION_GRACE_MS,
  check({ project }) {
    if (!project.projection?.project) return;
    const known = new Set(project.runs.map((run) => run.runId));
    const referenced = [project.projection.project.currentRunId, project.projection.project.promotedRunId, project.projection.run?.id]
      .filter((id): id is string => typeof id === "string")
      .filter((id) => !known.has(id));
    if (!referenced.length) return;
    violate(projectionStoreMismatch, `状态投影指向本 store 没有的 run：${[...new Set(referenced)].join(", ")}`, {
      storageRoot: project.storageRoot,
      storageRootSource: project.storageRootSource,
      candidates: project.storageRootCandidates.map((candidate) => ({ root: candidate.root, source: candidate.source, hasState: candidate.hasState, projectUpdatedAt: candidate.projectUpdatedAt })),
      projectionRuns: [...new Set(referenced)],
      knownRuns: project.runs.map((run) => run.runId),
    });
  },
};

/**
 * A run belongs to exactly one conversation. Cross-session workspace commits
 * or a runtime attached to another run mean the isolation boundary leaked.
 */
const runOwnershipUnique: ReifyInvariantDefinition = {
  name: "run-ownership-unique",
  severity: "P1",
  scope: "session-run-isolation",
  title: "一个 run 只能属于一个会话",
  why: "两个会话共用一个 run，会让一个会话的设计动作出现在另一个会话里。",
  stateSources: ["runs/<runId>/workspace/commits/<id>.json", "runs/<runId>/state.json", "runs/<runId>/recipe-runs/<id>/record/run.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      if (run.commitSessions.length > 1) {
        violate(runOwnershipUnique, `run ${run.runId} 被 ${run.commitSessions.length} 个会话写过：${run.commitSessions.join(", ")}`, { run: run.runId, sessions: run.commitSessions });
      }
      if (run.state && project.projectState && run.state.projectId !== project.projectState.projectId) {
        violate(runOwnershipUnique, `run ${run.runId} 属于 project ${run.state.projectId}，不是 ${project.projectState.projectId}`, { run: run.runId, runProjectId: run.state.projectId, projectId: project.projectState.projectId });
      }
      for (const recipe of run.recipeRuns) {
        if (recipe.workflowRunId && recipe.workflowRunId !== run.runId) {
          violate(runOwnershipUnique, `run ${run.runId} 里的 runtime ${recipe.recipeRunId} 属于 run ${recipe.workflowRunId}`, { run: run.runId, runtime: recipe.recipeRunId, owner: recipe.workflowRunId });
        }
      }
    }
  },
};

/**
 * A lock or staging directory may outlive its owner only briefly. Anything
 * longer is a crash that nobody cleaned up and will block the next writer.
 */
const noOrphanOwner: ReifyInvariantDefinition = {
  name: "no-orphan-owner",
  severity: "P1",
  scope: "runtime-lifecycle",
  title: "owner 进程死了不能留下锁或半成品目录",
  why: "死进程留下的锁和 staging 目录会挡住下一次 write，也让半成品看起来像真 run。",
  stateSources: ["<store>/.head.lock", "runs/<runId>/recipe-runs/*.staging-<pid>"],
  graceMs: ORPHAN_GRACE_MS,
  check({ project, graceMs }) {
    const locks = [...project.projectLocks, ...project.runs.flatMap((run) => run.locks)];
    const deadLocks = locks.filter((lock) => lock.ownerAlive === false && lock.ageMs > graceMs);
    if (deadLocks.length) {
      violate(noOrphanOwner, `${deadLocks.length} 个锁的 owner 已经不在了`, {
        locks: deadLocks.map((lock) => ({ path: lock.path, pid: lock.pid, ageMs: lock.ageMs })),
      });
    }
    const staging = project.runs.flatMap((run) => run.staging);
    const deadStaging = staging.filter((item) => item.ownerAlive === false && item.ageMs > graceMs);
    if (deadStaging.length) {
      violate(noOrphanOwner, `${deadStaging.length} 个 staging 目录的 owner 已经不在了`, {
        staging: deadStaging.map((item) => ({ path: item.path, pid: item.pid, ageMs: item.ageMs })),
      });
    }
  },
};

/**
 * A run that the runtime still drives must keep advancing. Once the budget is
 * spent with no live owner, recovery never happened.
 */
const recoveryConvergence: ReifyInvariantDefinition = {
  name: "recovery-convergence",
  severity: "P1",
  scope: "recovery",
  title: "故障后必须在预算内收敛",
  why: "没人推进、又没进终态的 run 会一直挂在那里，恢复靠人推就不是恢复。",
  stateSources: ["runs/<runId>/HEAD", "runs/<runId>/state.json", "<store>/.head.lock"],
  graceMs: RECOVERY_BUDGET_MS,
  budgetMs: RECOVERY_BUDGET_MS,
  check({ project, graceMs }) {
    const stalled: Array<Record<string, JsonValue>> = [];
    for (const run of project.runs) {
      if (!run.state || !LIVE.has(run.state.status)) continue;
      if (run.advanceAgeMs === null || run.advanceAgeMs <= graceMs) continue;
      const liveOwner = run.locks.some((lock) => lock.ownerAlive === true);
      if (liveOwner) continue;
      stalled.push({ run: run.runId, status: run.state.status, phase: run.state.phase, advanceAgeMs: run.advanceAgeMs, budgetMs: graceMs });
    }
    if (stalled.length) violate(recoveryConvergence, `${stalled.length} 个 run 超过预算还没收敛`, { stalled });
  },
};

/**
 * A runtime record that never advances past `running` is abandoned. It must be
 * reconciled, not left to look live forever.
 */
const noAbandonedRuntime: ReifyInvariantDefinition = {
  name: "no-abandoned-runtime",
  severity: "P1",
  scope: "recovery",
  title: "卡住的 runtime 必须被收敛掉",
  why: "running 记录一直不动，说明进程已经死了但记录还装活着，下一次操作会以它为真。",
  stateSources: ["runs/<runId>/recipe-runs/<id>/record/run.json", "runs/<runId>/recipe-runs/<id>/record/HEAD"],
  graceMs: RUNTIME_STALL_BUDGET_MS,
  budgetMs: RUNTIME_STALL_BUDGET_MS,
  check({ project, graceMs }) {
    const abandoned: Array<Record<string, JsonValue>> = [];
    for (const run of project.runs) {
      for (const recipe of run.recipeRuns) {
        if (recipe.status !== "running") continue;
        if (recipe.idleMs <= graceMs) continue;
        abandoned.push({ run: run.runId, runtime: recipe.recipeRunId, idleMs: recipe.idleMs, budgetMs: graceMs });
      }
    }
    if (abandoned.length) violate(noAbandonedRuntime, `${abandoned.length} 个 runtime 超过预算还在 running`, { abandoned });
  },
};

/**
 * A blocked run must say what it is waiting on, and a settled run must not
 * carry an unresolved blocker.
 */
const blockedStateHasBlocker: ReifyInvariantDefinition = {
  name: "blocked-state-has-blocker",
  severity: "P1",
  scope: "ui-backend",
  title: "blocked 状态必须说明卡在哪",
  why: "只显示 blocked 不说要什么，人和 agent 都没法解；done 还挂着 blocker 说明状态是假的。",
  stateSources: ["runs/<runId>/state.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      const state = run.state;
      if (!state) continue;
      if (BLOCKER_REQUIRED.has(state.status) && !state.blocker) {
        violate(blockedStateHasBlocker, `run ${run.runId} 是 ${state.status} 但没有 blocker`, { run: run.runId, status: state.status });
      }
      if (state.status === "done" && state.blocker) {
        violate(blockedStateHasBlocker, `run ${run.runId} 已经 done 还挂着 blocker`, { run: run.runId, blocker: state.blocker as unknown as JsonValue });
      }
    }
  },
};

/**
 * Authorities are single-use. Their identity must be unique and consumption
 * can never precede issue.
 */
const authorityLifecycleIntegrity: ReifyInvariantDefinition = {
  name: "authority-lifecycle-integrity",
  severity: "P1",
  scope: "session-run-isolation",
  title: "authority 只能发一次、用一次",
  why: "authority id 重复或先消费后签发，等于一个许可被用成两个。",
  stateSources: ["runs/<runId>/state.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      const authorities = run.state?.authorities ?? [];
      const seen = new Map<string, number>();
      for (const authority of authorities) {
        seen.set(authority.id, (seen.get(authority.id) ?? 0) + 1);
        if (authority.consumedAt && authority.consumedAt < authority.issuedAt) {
          violate(authorityLifecycleIntegrity, `run ${run.runId} 的 authority ${authority.id} 消费时间早于签发时间`, { run: run.runId, authority: authority.id, issuedAt: authority.issuedAt, consumedAt: authority.consumedAt });
        }
      }
      const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
      if (duplicates.length) violate(authorityLifecycleIntegrity, `run ${run.runId} 的 authority id 重复：${duplicates.join(", ")}`, { run: run.runId, duplicates });
    }
  },
};

/**
 * Evidence is only valid for the workflow generation that produced it, and it
 * must close an obligation that the pinned workflow really declares.
 */
const evidenceBindingIntegrity: ReifyInvariantDefinition = {
  name: "evidence-binding-integrity",
  severity: "P1",
  scope: "side-effect-artifact",
  title: "evidence 必须绑在当前的 workflow 和 obligation 上",
  why: "旧 workflow 的 evidence 留在当前集合里，会让已经过期的检查看起来还成立。",
  stateSources: ["runs/<runId>/state.json", "runs/<runId>/workflow.json"],
  graceMs: 0,
  check({ project }) {
    for (const run of project.runs) {
      const state = run.state;
      if (!state) continue;
      if (run.workflowError) violate(evidenceBindingIntegrity, `run ${run.runId} 读不到 workflow：${run.workflowError}`, { run: run.runId });
      const obligations = new Set<string>();
      for (const phase of Object.values(run.workflow?.phases ?? {})) {
        for (const obligation of [...phase.recordObligations, ...phase.evidenceObligations]) obligations.add(obligation.ref);
      }
      const stale = new Set(state.staleEvidence.map((item) => item.id));
      for (const evidence of state.evidence) {
        if (evidence.workflowHash !== state.workflow.hash) {
          violate(evidenceBindingIntegrity, `run ${run.runId} 的 evidence ${evidence.id} 属于另一个 workflow`, {
            run: run.runId, evidence: evidence.id, evidenceWorkflow: evidence.workflowHash, runWorkflow: state.workflow.hash,
          });
        }
        if (run.workflow && !obligations.has(evidence.obligationRef)) {
          violate(evidenceBindingIntegrity, `run ${run.runId} 的 evidence ${evidence.id} 绑的 obligation ${evidence.obligationRef} 不在 workflow 里`, {
            run: run.runId, evidence: evidence.id, obligationRef: evidence.obligationRef,
          });
        }
        if (stale.has(evidence.id)) {
          violate(evidenceBindingIntegrity, `run ${run.runId} 的 evidence ${evidence.id} 同时在当前集合和过期集合里`, { run: run.runId, evidence: evidence.id });
        }
      }
      for (const record of Object.values(state.records)) {
        if (record.workflowHash !== state.workflow.hash) {
          violate(evidenceBindingIntegrity, `run ${run.runId} 的 record ${record.obligationRef} 属于另一个 workflow`, {
            run: run.runId, record: record.obligationRef, recordWorkflow: record.workflowHash, runWorkflow: state.workflow.hash,
          });
        }
      }
    }
  },
};

export const reifySystemInvariants: ReifyInvariantDefinition[] = [
  runIdentityUnique,
  projectRunReferenceIntegrity,
  transactionHeadConsistent,
  stateMaterializationConsistent,
  terminalStateStable,
  settledRunNotReconciled,
  artifactIntegrity,
  noDuplicateEffect,
  repeatStepCommit,
  singleActiveRuntimePerRun,
  conversationRunBinding,
  projectionStoreMismatch,
  runOwnershipUnique,
  noOrphanOwner,
  recoveryConvergence,
  noAbandonedRuntime,
  blockedStateHasBlocker,
  authorityLifecycleIntegrity,
  evidenceBindingIntegrity,
];
