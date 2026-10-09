import { chmod, lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { HarnessProjectStateV7 } from "../harness/run-store.ts";
import type { WorkflowSnapshotV1 } from "../harness/workflow/types.ts";
import type { WorkflowCurrentView } from "../harness/card.ts";
import type { HarnessRunStateV7 } from "../harness/state.ts";
import { workflowRunStateView } from "../harness/workflow/phase-view.ts";

export interface StatusProjectionV1 {
  schema: 1;
  authoritative: false;
  project: { id: string; currentRunId: string | null; promotedRunId?: string };
  run: null | {
    id: string;
    workflowId: string;
    workflowVersion: string;
    workflowHash: string;
    phase: string;
    status: string;
    updatedAt: string;
    phaseHistory: string[];
    phases: Array<{
      id: string;
      title: string;
      purpose: string;
      status: "complete" | "active" | "pending" | "blocked" | "skipped";
      transitions: Array<{ event: string; target: string }>;
      capabilities: string[];
      obligations: string[];
    }>;
  };
  warning: string;
  updatedAt: string;
}

/** Workspace status is an atomic, replaceable projection and is never read as input. */
export async function writeStatusProjection(
  cwd: string,
  project: HarnessProjectStateV7,
  run: null | { state: HarnessRunStateV7; workflow: WorkflowSnapshotV1; view: WorkflowCurrentView },
): Promise<string> {
  const root = await realpath(resolve(cwd));
  const directory = join(root, ".pi-cad");
  const destination = join(directory, "status.json");
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("workspace .pi-cad projection directory cannot be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const projection: StatusProjectionV1 = {
    schema: 1,
    authoritative: false,
    project: {
      id: project.projectId,
      currentRunId: project.currentRunId,
      ...(project.promotedRunId ? { promotedRunId: project.promotedRunId } : {}),
    },
    run: run ? {
      id: run.state.runId,
      workflowId: run.workflow.id,
      workflowVersion: run.workflow.version,
      workflowHash: run.workflow.hash,
      phase: run.state.phase,
      status: run.state.status,
      updatedAt: run.state.updatedAt,
      phaseHistory: [...run.state.phaseHistory],
      phases: workflowRunStateView(run, run.view).phases,
    } : null,
    warning: "Projection only. Editing this file has no workflow or review authority.",
    updatedAt: new Date().toISOString(),
  };
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.status-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o444 });
  await rename(temporary, destination);
  await chmod(destination, 0o444);
  return destination;
}
