import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ReviewerModelSelection } from "../authority/prime-config.ts";
import { experienceRoot, finalizeExperience } from "./store.ts";

function latestPrimeSession(project: string): string | null {
  const root = join(project, ".prime-sessions");
  if (!existsSync(root)) return null;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  };
  visit(root, 0);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

export async function archivePrimeExperience(
  project: string,
  gate: { complete: boolean; outcome?: "complete" | "clarification_required"; reason?: string; runId?: string; workflowId?: string },
  author: ReviewerModelSelection | undefined,
): Promise<void> {
  if (process.env.PI_CAD_EXPERIENCE_ENABLED === "0") return;
  const sessionPath = latestPrimeSession(project);
  if (!sessionPath || !gate.runId) {
    process.stderr.write("[pi-cad] experience archival skipped: run has no persisted Prime session or run id\n");
    return;
  }
  try {
    const entry = await finalizeExperience({
      runId: gate.runId,
      workflow: gate.workflowId,
      projectPath: project,
      sessionPath,
      model: author ? `${author.provider}/${author.model}` : undefined,
      reasoning: author?.thinking,
      outcome: gate.outcome ?? (gate.complete ? "complete" : "incomplete"),
      outcomeReason: gate.reason,
    });
    const markerDirectory = join(project, ".pi-cad");
    await mkdir(markerDirectory, { recursive: true });
    const marker = join(markerDirectory, "experience.json");
    const temporary = `${marker}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schema: 1, seq: entry.seq, sha: entry.sha, root: experienceRoot(), runId: entry.run_id }, null, 2)}\n`, "utf8");
    await rename(temporary, marker);
  } catch (error) {
    process.stderr.write(`[pi-cad] experience archival failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
