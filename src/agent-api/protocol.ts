import type { JsonValue } from "../harness/canonical.ts";
import type { EncodedVariable } from "../harness/commit.ts";

export type AgentApiRequest =
  | { schema: 1; op: "workflow-current" }
  | { schema: 1; op: "workflow-advance"; event: string }
  | { schema: 1; op: "commit"; name: string; variables?: Record<string, EncodedVariable>; artifacts?: Array<string | { path: string; role?: string }>; session?: string }
  | { schema: 1; op: "load"; id: string }
  | { schema: 1; op: "history" }
  | { schema: 1; op: "probe"; subject: "current" | "baseline"; purpose: string; code: string }
  | { schema: 1; op: "model-build"; source: string; output: string; force?: boolean }
  | { schema: 1; op: "simulation-run"; recipe: string; obligationRef?: string; outputs?: string[]; action?: string }
  | { schema: 1; op: "review-current" };

export interface AgentApiResponse {
  schema: 1;
  ok: boolean;
  result?: JsonValue;
  error?: { type: string; message: string };
}
