import { canonicalDigest } from "../../harness/canonical.ts";
import type { JsonValue } from "../../harness/canonical.ts";
import { reifySystemInvariants } from "./catalog.ts";
import { readReifyProjectSnapshot } from "./snapshot.ts";
import {
  InvariantViolationError,
  type InvariantViolation,
  type ReifyProjectSnapshot,
  type ReifyInvariantDefinition,
} from "./types.ts";

export * from "./types.ts";
export { reifySystemInvariants } from "./catalog.ts";
export { readReifyProjectSnapshot, readReifyRunSnapshot } from "./snapshot.ts";

export interface InvariantCheckReport {
  cwd: string;
  checkedAt: string;
  /** Identity of the observed state, so a violation report is reproducible. */
  stateDigest: string;
  /** Every invariant that ran, pass or fail. */
  checked: string[];
  violations: InvariantViolation[];
  /** Non-violation observations worth keeping in the artifact. */
  observations: Record<string, JsonValue>;
}

export function stateDigest(project: ReifyProjectSnapshot): string {
  return canonicalDigest({
    cwd: project.cwd,
    projectHead: project.projectHeadGeneration,
    projectState: project.projectState
      ? { id: project.projectState.projectId, currentRunId: project.projectState.currentRunId, promotedRunId: project.projectState.promotedRunId ?? null }
      : null,
    runs: project.runs.map((run) => ({
      runId: run.runId,
      head: run.headGeneration,
      status: run.state?.status ?? null,
      phase: run.state?.phase ?? null,
      workflowHash: run.state?.workflow.hash ?? null,
      events: run.eventLineCount,
    })),
  } as JsonValue);
}

/**
 * Run every invariant against one real snapshot. A checker may throw an
 * `InvariantViolationError`; any other error is reported as a violation too,
 * because a checker that cannot read real state must not silently pass.
 */
export async function checkReifyInvariants(input: {
  cwd: string;
  /** Pin the project store when more than one candidate exists on disk. */
  storageRoot?: string;
  invariants?: ReifyInvariantDefinition[];
  now?: number;
}): Promise<InvariantCheckReport> {
  const now = input.now ?? Date.now();
  const project = await readReifyProjectSnapshot(input.cwd, now, { ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}) });
  const invariants = input.invariants ?? reifySystemInvariants;
  const violations: InvariantViolation[] = [];
  const checked: string[] = [];
  for (const invariant of invariants) {
    checked.push(invariant.name);
    try {
      await invariant.check({ project, now, graceMs: invariant.graceMs });
    } catch (error) {
      if (error instanceof InvariantViolationError) {
        violations.push(error.violation);
        continue;
      }
      violations.push({
        name: invariant.name,
        severity: invariant.severity,
        scope: invariant.scope,
        detail: `checker 自己失败：${error instanceof Error ? error.message : String(error)}`,
        evidence: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return {
    cwd: project.cwd,
    checkedAt: new Date(now).toISOString(),
    stateDigest: stateDigest(project),
    checked,
    violations,
    observations: {
      storageRoot: project.storageRoot,
      storageRootSource: project.storageRootSource,
      storageRootCandidates: project.storageRootCandidates.map((candidate) => ({
        root: candidate.root,
        source: candidate.source,
        hasState: candidate.hasState,
        projectUpdatedAt: candidate.projectUpdatedAt,
      })),
      projectId: project.projectState?.projectId ?? null,
      currentRunId: project.projectState?.currentRunId ?? null,
      promotedRunId: project.projectState?.promotedRunId ?? null,
      runCount: project.runs.length,
      runs: project.runs.map((run) => ({
        runId: run.runId,
        status: run.state?.status ?? null,
        phase: run.state?.phase ?? null,
        headGeneration: run.headGeneration,
        artifacts: run.artifacts.length,
        evidence: run.evidence.length,
        records: run.records.length,
        recipeRuns: run.recipeRuns.map((recipe) => ({ id: recipe.recipeRunId, status: recipe.status, idleMs: recipe.idleMs })),
      })),
      projection: project.projection
        ? { currentRunId: project.projection.project.currentRunId, runId: project.projection.run?.id ?? null, status: project.projection.run?.status ?? null }
        : null,
    },
  };
}

export function summariseReport(report: InvariantCheckReport): string {
  const bySeverity = { P0: 0, P1: 0, P2: 0 } as Record<string, number>;
  for (const violation of report.violations) bySeverity[violation.severity] = (bySeverity[violation.severity] ?? 0) + 1;
  const lines = [
    `checked ${report.checked.length} invariant(s) on ${report.cwd}`,
    `violations: ${report.violations.length} (P0 ${bySeverity.P0}, P1 ${bySeverity.P1}, P2 ${bySeverity.P2})`,
    `state digest: ${report.stateDigest}`,
  ];
  for (const violation of report.violations) lines.push(`- [${violation.severity}] ${violation.name}: ${violation.detail}`);
  return `${lines.join("\n")}\n`;
}
