import http from "node:http";

/**
 * Stand-in for an external dependency (LLM / OAuth / vendor API).
 *
 * Real traffic reaches it only through the Toxiproxy proxy, so faults injected
 * on the proxy are genuine TCP-level faults. The upstream keeps a request log
 * so the runner can prove whether a retried call actually crossed the wire.
 */
export interface UpstreamOptions {
  port?: number;
  host?: string;
  /** Default response delay for POST /v1/complete when the caller omits one. */
  defaultDelayMs?: number;
}

export interface UpstreamHandle {
  port: number;
  url: string;
  requests: { token: string; at: number }[];
  close(): Promise<void>;
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

export async function startUpstream(options: UpstreamOptions = {}): Promise<UpstreamHandle> {
  const requests: { token: string; at: number }[] = [];
  const defaultDelayMs = options.defaultDelayMs ?? 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/complete") {
      const body = await readJson(req);
      const token = String(body?.token ?? "unknown");
      requests.push({ token, at: Date.now() });
      const delay = Number.isFinite(body?.delayMs) ? Number(body.delayMs) : defaultDelayMs;
      const reply = () => send(res, 200, { ok: true, token, servedAt: Date.now() });
      if (delay > 0) setTimeout(reply, delay);
      else reply();
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      send(res, 200, { requests, count: requests.length });
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      requests.length = 0;
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : Number(options.port ?? 0);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Child-process entry point (`__upstream`). */
export async function runUpstreamEntry(argv: string[]): Promise<void> {
  let port = 0;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") port = Number(argv[index + 1]);
  }
  const handle = await startUpstream({ port });
  process.stdout.write(`CHAOS_UPSTREAM_READY ${handle.url}\n`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
