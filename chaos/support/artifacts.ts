import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where every chaos failure artifact is written (chaos/artifacts/). */
export const ARTIFACTS_DIR = fileURLToPath(new URL("../artifacts/", import.meta.url));

/**
 * Write one failure artifact as pretty JSON under a timestamped, invariant-named
 * file. `prefix` tells the toy harness artifacts from the real-Reify ones.
 */
export function writeArtifactJson(prefix: string, invariant: string, artifact: unknown): string {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = `${prefix}${invariant.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60)}`;
  const file = path.join(ARTIFACTS_DIR, `${stamp}-${slug}.json`);
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return file;
}
