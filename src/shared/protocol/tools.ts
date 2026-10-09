/**
 * Tool name lists and the envelope every cad_* tool result is wrapped in.
 */

import { ACTIVE_CAPABILITY_TOOLS, ACTIVE_CONTROL_TOOLS } from "../public-tools.ts";
import type { EvidenceInputArtifact } from "./evidence.ts";

export const CONTROL_TOOLS = ACTIVE_CONTROL_TOOLS;
export const CAPABILITY_TOOLS = ACTIVE_CAPABILITY_TOOLS;

export interface CadEventEnvelope {
  ok: boolean;
  tool: string;
  toolVersion: string;
  backendVersion?: string;
  inputHashes: Record<string, string>;
  /** Hash-bound inputs with paths+roles, carried into evidence provenance. */
  inputArtifacts?: EvidenceInputArtifact[];
  outputHashes: Record<string, string>;
  durationMs: number;
  warnings: string[];
  artifacts: Array<{ path: string; kind: string; sha256: string }>;
  payload: Record<string, unknown>;
}
