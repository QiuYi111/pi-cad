import type { JsonValue } from "../harness/canonical.ts";
import type { AcceptanceSummaryInput, EncodedVariable } from "../harness/commit.ts";
import type { ModelParameterDefinitionInput } from "../shared/model-parameters.ts";

export interface AgentArtifactSubject {
  kind: "artifact";
  path: string;
  sha256?: string;
  role?: string;
}

/**
 * Prime conversation identity. `binding` is the durable transcript binding
 * the extension restores, and its presence is authoritative: an explicit
 * `null` declares a read transcript with no binding, so the conversation
 * stays unbound instead of inheriting a registry entry from history.
 * `bindingReadAt` is the read time the sidecar compares against the project
 * conversation registry, which is how a run started by this conversation's
 * cad Python kernel reaches the transcript. `runId` is kept for callers that
 * assert only the run. An unbound conversation has no run — it never inherits
 * the project-global pointer.
 */
export interface AgentApiConversationV1 {
  /**
   * The Prime conversation this request belongs to. Naming no session at all
   * (`undefined`) is a stateless caller that keeps the legacy project-global
   * pointer; an explicit `null` is a conversation window which has no Prime
   * session yet, so it stays unbound instead of inheriting that pointer.
   */
  sessionId?: string | null;
  runId?: string;
  binding?: { schema: 1; sessionId: string; runId: string; workflowHash: string; boundAt: string } | null;
  bindingReadAt?: string;
}

export type AgentApiRequest = AgentApiConversationV1 & (
  | { schema: 1; op: "workflow-list" }
  | { schema: 1; op: "workflow-current" }
  | { schema: 1; op: "workflow-start"; id: string; interactionMode?: "interactive" | "headless" }
  | { schema: 1; op: "workflow-advance"; event: string }
  | { schema: 1; op: "commit"; name: string; parent?: string | null; variables?: Record<string, EncodedVariable>; artifacts?: Array<string | { path: string; role?: string }>; session?: string; acceptance?: AcceptanceSummaryInput }
  | { schema: 1; op: "load"; id: string }
  | { schema: 1; op: "history" }
  | { schema: 1; op: "viewer-catalog" }
  | { schema: 1; op: "evidence-read"; path: string }
  | { schema: 1; op: "probe"; preset?: string; subject?: "current" | "baseline" | AgentArtifactSubject; purpose?: string; code?: string; args?: Record<string, JsonValue> }
  | { schema: 1; op: "model-build"; source: string; output: string; force?: boolean; validation?: "auto" | "fast" | "full"; parameters?: Record<string, ModelParameterDefinitionInput>; importMode?: "reference" | "solidify" }
  | { schema: 1; op: "simulation-run"; recipe: string; obligationRef?: string; outputs?: string[]; action?: string }
  | { schema: 1; op: "review-submit"; subjectCommit: string }
  | { schema: 1; op: "review-current"; reviewId?: string }
  | { schema: 1; op: "review-complete"; reviewId: string; result: { verdict: "pass" | "fail" | "clarification_required"; target: string; summary: string; findings: Array<{ id: string; severity: "info" | "warning" | "error"; finding: string; evidenceRefs: string[] }> } }
  | { schema: 1; op: "review-watch"; after?: string }
);

export interface AgentApiResponse {
  schema: 1;
  ok: boolean;
  result?: JsonValue;
  error?: { type: string; message: string };
}
