import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface AuthorityRequestOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestAuthorityOnce<T>(request: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const path = process.env.PI_CAD_AUTHOR_SOCKET;
  if (!path) throw new Error("Pi-CAD authority sidecar socket is not configured");
  return new Promise<T>((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      accept(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const socket = createConnection(path);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Pi-CAD authority sidecar timeout")));
    socket.on("connect", () => socket.end(JSON.stringify({ schema: 1, ...request })));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) socket.destroy(new Error("Pi-CAD authority response exceeds byte limit"));
      else chunks.push(chunk);
    });
    socket.on("error", rejectOnce);
    socket.on("close", () => {
      if (!chunks.length) {
        rejectOnce(new Error("Pi-CAD authority sidecar closed without a response"));
        return;
      }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { ok?: boolean; result?: T; error?: { message?: string } };
        if (!response.ok) rejectOnce(new Error(response.error?.message ?? "Pi-CAD authority sidecar rejected the request"));
        else resolveOnce(response.result as T);
      } catch (error) {
        rejectOnce(error);
      }
    });
  });
}

/**
 * Send one authority request. Callers that are rendering provider context may
 * opt into a small retry budget: a transient Unix-socket/CAS read failure must
 * not be misrepresented to the model as a permanent loss of authority.
 * Mutating engineering calls deliberately retain the default of zero retries.
 */
export async function requestAuthority<T>(request: Record<string, unknown>, options: AuthorityRequestOptions = {}): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 25));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestAuthorityOnce<T>(request, options.timeoutMs ?? 30_000);
    } catch (error) {
      lastError = error;
      if (attempt < retries && retryDelayMs) await delay(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}
