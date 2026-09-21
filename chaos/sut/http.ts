import http from "node:http";

export interface HttpResult {
  status: number;
  body: any;
}

export interface HttpLogEntry {
  at: number;
  method: string;
  url: string;
  status: number | null;
  error?: string;
}

/** Runner-side API call log, used to build the failure artifact. */
export const httpLog: HttpLogEntry[] = [];

export function resetHttpLog(): void {
  httpLog.length = 0;
}

/**
 * Minimal JSON-over-HTTP client. We deliberately avoid global fetch/undici so
 * that a host-level HTTP(S)_PROXY can never reroute loopback chaos traffic.
 */
export function httpJson(
  method: string,
  url: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      httpLog.push({ at: Date.now(), method, url, status: null, error: (error as Error).message });
      reject(error as Error);
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        method,
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        headers: payload
          ? { "content-type": "application/json", "content-length": String(payload.length) }
          : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          if (text.trim().length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
          httpLog.push({ at: Date.now(), method, url, status: response.statusCode ?? 0 });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timeout after ${timeoutMs}ms: ${method} ${url}`));
    });
    request.on("error", (error) => {
      httpLog.push({ at: Date.now(), method, url, status: null, error: error.message });
      reject(error);
    });
    if (payload) request.write(payload);
    request.end();
  });
}

export async function api<T = any>(
  method: string,
  url: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  const result = await httpJson(method, url, body, timeoutMs);
  if (result.status >= 400) {
    throw new Error(`${method} ${url} -> ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body as T;
}

export const get = <T = any>(url: string, timeoutMs?: number) => api<T>("GET", url, undefined, timeoutMs);
export const post = <T = any>(url: string, body?: unknown, timeoutMs?: number) =>
  api<T>("POST", url, body ?? {}, timeoutMs);
export const del = <T = any>(url: string, timeoutMs?: number) => api<T>("DELETE", url, undefined, timeoutMs);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 5_000, intervalMs = 25, label = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}
