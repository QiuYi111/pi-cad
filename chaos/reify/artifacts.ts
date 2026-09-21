import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACTS_DIR } from "../runner/artifacts.ts";
import type { ApiLogEntry } from "./session.ts";
import type { ReifyTimelineEntry } from "./trace.ts";
import type { Command } from "./model.ts";

/**
 * A failure artifact for the real Reify slice. It keeps the same replay fields
 * as the POC harness (seed / path / sequences) and adds the real identities a
 * person needs to look the failure up: run, conversation and kernel ids.
 */
export interface ReifyFailureArtifact {
  schema: 1;
  sut: "reify";
  createdAt: string;
  invariant: string;
  detail: string;
  evidence?: unknown;
  seed: number;
  replayPath: string;
  /**
   * fast-check `maxLength` used to build the sequence arbitrary. A replay path
   * only resolves against the same generator shape, so it is stored with the
   * seed and replayed together.
   */
  maxCommands: number;
  originalSequence: Command[];
  shrunkSequence: Command[];
  replaySequence: Command[];
  reproducible: boolean;
  actionSequence: Command[];
  faultSequence: Command[];
  requests: ApiLogEntry[];
  ids: { conversations: string[]; runs: string[]; kernels: string[] };
  stateTimeline: ReifyTimelineEntry[];
  logs: string[];
  recoveries: { at: number; after: string; buildMs: number }[];
  project: { root: string; project: string; canonical: string; workflowHome: string };
}

export function saveReifyArtifact(artifact: ReifyFailureArtifact): string {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = `reify-${artifact.invariant.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60)}`;
  const file = path.join(ARTIFACTS_DIR, `${stamp}-${slug}.json`);
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return file;
}

export function loadReifyArtifact(file: string): ReifyFailureArtifact {
  const artifact = JSON.parse(readFileSync(file, "utf8")) as ReifyFailureArtifact;
  if (artifact.schema !== 1 || artifact.sut !== "reify") {
    throw new Error(`${file} 不是真 Reify slice 的 artifact`);
  }
  // Artifacts written before the path replay fix do not carry the generator
  // length; fall back to the recorded sequence so they still load.
  artifact.maxCommands ??= Math.max(artifact.originalSequence.length, 4);
  return artifact;
}
