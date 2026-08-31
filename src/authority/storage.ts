import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { HarnessProjectStateV7 } from "../harness/run-store.ts";
import type { WorkflowSnapshotV1 } from "../harness/workflow/types.ts";
import type { WorkflowCurrentView } from "../harness/card.ts";
import type { HarnessRunStateV7 } from "../harness/state.ts";

const CANONICAL_DIRECTORY_ENV = "PI_CAD_CANONICAL_PROJECT_DIR";

export function canonicalProjectKey(cwd: string): string {
  return createHash("sha256").update(realpathSync(resolve(cwd))).digest("hex");
}

export function defaultCanonicalProjectDirectory(cwd: string): string {
  const dataHome = process.env.XDG_DATA_HOME
    ? resolve(process.env.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  return join(dataHome, "pi-cad", canonicalProjectKey(cwd));
}

/** Direct library tests retain prototype storage unless a sidecar supplies its private root. */
export function harnessStorageRoot(cwd: string): string {
  const configured = process.env[CANONICAL_DIRECTORY_ENV];
  if (!configured) return join(resolve(cwd), ".pi-cad");
  if (!isAbsolute(configured)) throw new Error(`${CANONICAL_DIRECTORY_ENV} must be absolute`);
  return resolve(configured);
}

export function harnessRunDirectory(cwd: string, runId: string): string {
  return join(harnessStorageRoot(cwd), "runs", runId);
}

export function harnessProjectDirectory(cwd: string): string {
  return join(harnessStorageRoot(cwd), "v7-project");
}

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
      phases: Object.entries(run.workflow.phases).map(([id, phase]) => ({
        id,
        title: id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
        purpose: phase.purpose,
        status: id === run.state.phase
          ? (run.state.status === "done" ? "complete" : ["blocked_user", "blocked_external", "waiting_user", "aborted"].includes(run.state.status) ? "blocked" : "active")
          : run.state.phaseHistory.includes(id) ? "complete" : ["done", "aborted"].includes(run.state.status) ? "skipped" : "pending",
        transitions: id === run.state.phase
          ? run.view.next.map((item) => ({ event: item.event, target: item.target }))
          : Object.entries(phase.transitions).map(([event, transition]) => ({ event, target: transition.target })),
        capabilities: id === run.state.phase ? run.view.operations.map((item) => item.capability) : [],
        obligations: id === run.state.phase ? [...run.view.unmet] : [],
      })),
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
