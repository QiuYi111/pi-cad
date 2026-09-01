import type { JsonValue } from "../harness/canonical.ts";
import type { EncodedVariable } from "../harness/commit.ts";

export interface AgentArtifactSubject {
  kind: "artifact";
  path: string;
  sha256?: string;
  role?: string;
}

export type AgentApiRequest =
  | { schema: 1; op: "workflow-list" }
  | { schema: 1; op: "workflow-current" }
  | { schema: 1; op: "workflow-start"; id: string; interactionMode?: "interactive" | "headless" }
  | { schema: 1; op: "workflow-advance"; event: string }
  | { schema: 1; op: "commit"; name: string; parent?: string | null; variables?: Record<string, EncodedVariable>; artifacts?: Array<string | { path: string; role?: string }>; session?: string }
  | { schema: 1; op: "load"; id: string }
  | { schema: 1; op: "history" }
  | { schema: 1; op: "viewer-catalog" }
  | { schema: 1; op: "probe"; subject: "current" | "baseline" | AgentArtifactSubject; purpose: string; code: string }
  | { schema: 1; op: "model-build"; source: string; output: string; force?: boolean }
  | { schema: 1; op: "simulation-run"; recipe: string; obligationRef?: string; outputs?: string[]; action?: string }
  | { schema: 1; op: "review-submit"; subjectCommit: string }
  | { schema: 1; op: "review-current"; reviewId?: string }
  | { schema: 1; op: "review-complete"; reviewId: string; result: { verdict: "pass" | "fail" | "clarification_required"; target: string; summary: string; findings: Array<{ id: string; severity: "info" | "warning" | "error"; finding: string; evidenceRefs: string[] }> } }
  | { schema: 1; op: "review-watch"; after?: string };

export interface AgentApiResponse {
  schema: 1;
  ok: boolean;
  result?: JsonValue;
  error?: { type: string; message: string };
}
