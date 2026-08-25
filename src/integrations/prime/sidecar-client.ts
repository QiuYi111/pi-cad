import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function requestAuthority<T>(request: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<T> {
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
    socket.setTimeout(options.timeoutMs ?? 30_000, () => socket.destroy(new Error("Pi-CAD authority sidecar timeout")));
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
