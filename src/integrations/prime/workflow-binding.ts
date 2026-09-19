/**
 * Durable conversation → run binding.
 *
 * One Prime conversation owns one workflow binding; the binding is persisted
 * in that conversation's own transcript as a hidden
 * `pi-cad.workflow-binding` custom entry, and nowhere else. This module is
 * deliberately dependency-free: the extension runs inside the Prime sandbox
 * where only `src/integrations/prime` is mounted.
 */
export const WORKFLOW_BINDING_CUSTOM_TYPE = "pi-cad.workflow-binding";

export interface ConversationBindingV1 {
  schema: 1;
  sessionId: string;
  runId: string;
  workflowHash: string;
  boundAt: string;
}

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_SESSION_ID_LENGTH = 256;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f]/.test(value);
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function parseConversationBinding(value: unknown, sessionId?: string): ConversationBindingV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== 1) return null;
  if (!isSessionId(record.sessionId)) return null;
  if (sessionId !== undefined && record.sessionId !== sessionId) return null;
  if (!isRunId(record.runId)) return null;
  if (typeof record.workflowHash !== "string" || !record.workflowHash) return null;
  if (typeof record.boundAt !== "string" || Number.isNaN(Date.parse(record.boundAt))) return null;
  return { schema: 1, sessionId: record.sessionId, runId: record.runId, workflowHash: record.workflowHash, boundAt: record.boundAt };
}

/**
 * Read the newest binding for one conversation out of its own transcript
 * entries. Entries are append-only, so the last matching entry wins; a
 * transcript without a binding stays unbound and never inherits a run.
 */
export function bindingFromTranscriptEntries(entries: readonly unknown[], sessionId: string): ConversationBindingV1 | null {
  let found: ConversationBindingV1 | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.customType !== WORKFLOW_BINDING_CUSTOM_TYPE) continue;
    const parsed = parseConversationBinding(record.data, sessionId);
    if (parsed) found = parsed;
  }
  return found;
}
