import { readFileSync } from "node:fs";
import type { Command } from "../model/commands.ts";
import type { HttpLogEntry } from "../sut/http.ts";
import type { BugName } from "../sut/server.ts";
import type { TimelineEntry } from "../types.ts";
import { writeArtifactJson } from "../support/artifacts.ts";

export interface FailureArtifact {
  schema: 1;
  createdAt: string;
  invariant: string;
  detail: string;
  /** fast-check seed that reproduces the failure. */
  seed: number;
  /** fast-check counterexample path. */
  replayPath: string;
  /** The first randomly generated failing sequence (pre-shrink). */
  originalSequence: Command[];
  /** The shrunk counterexample that still reproduces. */
  shrunkSequence: Command[];
  /** The sequence that actually reproduced during artifact capture. */
  replaySequence: Command[];
  /** Whether the captured sequence reproduced the failure on replay. */
  reproducible: boolean;
  actionSequence: Command[];
  faultSequence: Command[];
  apiRequests: HttpLogEntry[];
  externalRequests: { token: string; at: number }[];
  ids: { projects: string[]; runs: string[]; workers: string[] };
  stateTimeline: TimelineEntry[];
  logs: string[];
  sut: { bug: BugName | null; controlUrl: string; externalUrl: string; upstreamUrl: string };
}

export function saveArtifact(artifact: FailureArtifact): string {
  return writeArtifactJson("", artifact.invariant, artifact);
}

export function loadArtifact(file: string): FailureArtifact {
  return JSON.parse(readFileSync(file, "utf8")) as FailureArtifact;
}
