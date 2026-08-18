import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { currentRunEvidenceRoot } from "./capability.ts";
import { CadProjectStore } from "./store.ts";

export type SpecNamespace = "simulation" | "optimization" | "drawing" | "presentation";

/**
 * Canonicalize a structured tool argument object into run-scoped evidence
 * storage. Tools never accept a spec path or an output directory from the
 * agent: the harness decides where specs and outputs live, so read-only
 * phases can produce evidence without any project-tree mutation and the
 * mutation policy has no outputDir bypass.
 *
 * Returns absolute paths for both the written spec and the output directory.
 */
export async function writeRunSpec(
  cwd: string,
  namespace: SpecNamespace,
  spec: unknown,
): Promise<{ specPath: string; outputDir: string }> {
  const store = new CadProjectStore(cwd);
  const runId = await store.currentRunId();
  const root = runId ? await currentRunEvidenceRoot(cwd) : null;
  const dir = runId && root
    ? join(root, namespace, randomUUID().slice(0, 8))
    : join(cwd, ".pi-cad", "adhoc", namespace, randomUUID().slice(0, 8));
  await mkdir(dir, { recursive: true });
  const specPath = join(dir, "spec.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf-8");
  return { specPath, outputDir: dir };
}
