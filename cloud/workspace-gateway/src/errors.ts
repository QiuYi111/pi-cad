import { WorkspacePathError, type ErrorCode, type GatewayMessage } from "@reify/cloud-protocol";

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function errorMessage(ch: number | undefined, error: unknown): GatewayMessage {
  const message = error instanceof Error ? error.message : String(error);
  return { type: "error", ...(ch === undefined ? {} : { ch }), code: errorCode(error), message };
}

function errorCode(error: unknown): ErrorCode {
  if (error instanceof ProtocolError || error instanceof WorkspacePathError) return error.code as ErrorCode;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "not_found";
  return "failed";
}
