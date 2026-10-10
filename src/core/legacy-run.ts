import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const TERMINAL_V6_STATUSES = ["done", "aborted", "blocked_external", "budget_exhausted"];

/**
 * v7 (Harness Kernel) is the only engine. A project whose legacy v3-v6 run is
 * still unfinished is refused, not migrated: the owner must move or delete the
 * old run state to start fresh.
 */
export async function assertNoLegacyRun(cwd: string): Promise<void> {
  const piCad = join(resolve(cwd), ".pi-cad");
  const pointer = await readFile(join(piCad, "project.json"), "utf-8")
    .then((raw) => JSON.parse(raw) as { schemaVersion?: number; currentRunId?: string | null })
    .catch(() => null);
  // Every legacy layout (schema 3-6) is refused while its run is unfinished, not silently ignored.
  if (pointer && typeof pointer.schemaVersion === "number" && pointer.schemaVersion >= 3 && pointer.schemaVersion <= 6 && pointer.currentRunId) {
    const runId = pointer.currentRunId;
    const status = await readFile(join(piCad, "runs", runId, "state.json"), "utf-8")
      .then((raw) => (JSON.parse(raw) as { status?: string }).status)
      .catch(() => undefined);
    if (status !== undefined && !TERMINAL_V6_STATUSES.includes(status)) {
      throw new Error(
        `Pi-CAD v6 kernel was removed and this project has an unfinished legacy v${pointer.schemaVersion} run (${runId}, status=${status}). ` +
          `Start fresh by moving or deleting the old run state: mv .pi-cad/project.json .pi-cad/project.json.v6-old ` +
          `(and optionally .pi-cad/runs/${runId}), then retry.`,
      );
    }
  }
}
