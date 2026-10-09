import type { AgentApiResponse } from "./protocol.ts";

type ErrorBody = NonNullable<AgentApiResponse["error"]>;

/**
 * Wire form of a thrown error. Part backend errors (`PartOpError`) keep their
 * stable code, target, detail, hints and rollback flag; everything else is a
 * type and a message.
 */
export function agentApiErrorBody(error: unknown): ErrorBody {
  if (!(error instanceof Error)) return { type: "Error", message: String(error) };
  const fields = error as Error & { code?: unknown; target?: unknown; detail?: unknown; hints?: unknown; rolledBack?: unknown };
  const body: ErrorBody = { type: error.name, message: error.message };
  if (error.name === "PartOpError" && typeof fields.code === "string") {
    body.code = fields.code;
    if (typeof fields.target === "string") body.target = fields.target;
    if (fields.detail && typeof fields.detail === "object") body.detail = fields.detail as ErrorBody["detail"];
    if (Array.isArray(fields.hints)) body.hints = fields.hints.map(String);
    if (typeof fields.rolledBack === "boolean") body.rolledBack = fields.rolledBack;
  }
  return body;
}
