import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

/**
 * A real fault-injecting forward proxy on loopback.
 *
 * It is not a re-implementation of the provider: the upstream leg is a real
 * TLS connection to the real provider endpoint carrying the real request
 * (including the real credential header). The proxy only sits on the wire and
 * breaks it the way a network fault would:
 *
 * - `latency`  : delay the request by `delayMs` before it reaches upstream.
 * - `hang`     : accept the request and never answer, so the client's own
 *                timeout is the real failure, not a fabricated one.
 * - `reset`    : drop the client connection right away (ECONNRESET).
 * - `truncate` : forward the first `bytes` of the real response, then cut.
 * - `status`   : answer with a real HTTP status (429 / 5xx) without calling
 *                upstream. Only used for status faults that a transport-only
 *                proxy cannot express.
 */
export type ProviderFaultMode = "latency" | "hang" | "reset" | "truncate" | "status";

export interface ProviderUpstream {
  protocol: "http" | "https";
  host: string;
  port: number;
  /**
   * The base path of the real provider endpoint, if it has one.
   *
   * Real providers mount their API under a path (`https://api.z.ai/api/coding/paas/v4`).
   * Keeping only host/port made the proxy forward `/models` to
   * `https://api.z.ai/models`, which answers 404 — so a `latency` fault could
   * never land (it needs the real upstream answer) and every round that picked
   * it honestly reported an injection failure.
   */
  basePath?: string;
}

export interface ProviderFaultPlan {
  mode: ProviderFaultMode;
  /** Milliseconds of added delay for `latency`; also the body cut delay. */
  delayMs?: number;
  /** Byte budget for `truncate`. */
  bytes?: number;
  /** HTTP status for `status`. */
  status?: number;
  body?: string;
}

export interface ProviderProxyStats {
  connections: number;
  faults: number;
  bytesUp: number;
  bytesDown: number;
}

const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

/** Split a real provider base URL into the pieces the proxy needs. */
export function parseUpstream(baseUrl: string): ProviderUpstream {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`provider endpoint must be http(s), got ${url.protocol}`);
  }
  return {
    protocol: url.protocol === "https:" ? "https" : "http",
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    // `/` means "no prefix": mounting `/` again would produce `//models`.
    basePath: url.pathname.replace(/\/+$/, ""),
  };
}

export class ProviderFaultProxy {
  private readonly stats: ProviderProxyStats = { connections: 0, faults: 0, bytesUp: 0, bytesDown: 0 };

  private constructor(
    private readonly server: Server,
    private readonly upstream: ProviderUpstream,
    private readonly plan: ProviderFaultPlan,
    readonly port: number,
  ) {}

  static async start(upstream: ProviderUpstream, plan: ProviderFaultPlan): Promise<ProviderFaultProxy> {
    let created: ProviderFaultProxy | null = null;
    const server = createServer((incoming, outgoing) => created?.handle(incoming, outgoing));
    server.on("connection", () => {
      if (created) created.stats.connections += 1;
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        accept();
      });
    });
    const { port } = server.address() as AddressInfo;
    created = new ProviderFaultProxy(server, upstream, plan, port);
    return created;
  }

  /** The plain-HTTP entry point the chaos client talks to. */
  urlFor(path: string): string {
    return `http://127.0.0.1:${this.port}${path.startsWith("/") ? path : `/${path}`}`;
  }

  get observations(): ProviderProxyStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    await new Promise<void>((accept) => {
      this.server.closeAllConnections?.();
      this.server.close(() => accept());
    });
  }

  private handle(incoming: IncomingMessage, outgoing: ServerResponse): void {
    const plan = this.plan;
    const target = new URL(incoming.url ?? "/", `${this.upstream.protocol}://${this.upstream.host}:${this.upstream.port}`);
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue;
      if (["host", "connection", "proxy-connection", "content-length", "transfer-encoding"].includes(key)) continue;
      headers[key] = value;
    }
    headers.host = this.upstream.port === (this.upstream.protocol === "https" ? 443 : 80)
      ? this.upstream.host
      : `${this.upstream.host}:${this.upstream.port}`;

    if (plan.mode === "status") {
      this.stats.faults += 1;
      const status = plan.status ?? 500;
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(plan.body ?? JSON.stringify({ error: { message: `chaos injected HTTP ${status}` } }));
      return;
    }

    if (plan.mode === "reset") {
      this.stats.faults += 1;
      // A real RST, so the client sees a connection reset and not a clean EOF.
      outgoing.socket.resetAndDestroy?.();
      outgoing.destroy();
      return;
    }

    if (plan.mode === "hang") {
      this.stats.faults += 1;
      // Hold the request open forever; the client's own timeout must fire.
      incoming.on("close", () => undefined);
      return;
    }

    const before = plan.mode === "latency" ? sleep(plan.delayMs ?? 250) : Promise.resolve();
    void before.then(() => {
      if (outgoing.writableEnded || outgoing.destroyed) return;
      const send = this.upstream.protocol === "https" ? httpsRequest : httpRequest;
      const upstreamRequest = send(
        {
          protocol: `${this.upstream.protocol}:`,
          host: this.upstream.host,
          port: this.upstream.port,
          method: incoming.method,
          // The real provider path prefix belongs in front of the request path:
          // the client asks the loopback proxy for `/models`, the provider
          // really serves `<basePath>/models`.
          path: `${this.upstream.basePath ?? ""}${target.pathname}${target.search}`,
          headers,
        },
        (upstreamResponse) => {
          outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers as Record<string, string | string[]>);
          if (plan.mode !== "truncate") {
            upstreamResponse.on("data", (chunk: Buffer) => {
              this.stats.bytesDown += chunk.length;
            });
            upstreamResponse.pipe(outgoing);
            return;
          }
          // Stream cut: forward a real prefix of the real response, then break.
          this.stats.faults += 1;
          let forwarded = 0;
          const budget = plan.bytes ?? 64;
          upstreamResponse.on("data", (chunk: Buffer) => {
            if (forwarded >= budget) return;
            const slice = chunk.subarray(0, Math.max(0, budget - forwarded));
            forwarded += slice.length;
            this.stats.bytesDown += slice.length;
            outgoing.write(slice);
            if (forwarded >= budget) {
              setTimeout(() => {
                outgoing.socket.resetAndDestroy?.();
                outgoing.destroy();
                upstreamResponse.destroy();
              }, plan.delayMs ?? 0);
            }
          });
        },
      );
      upstreamRequest.on("error", () => {
        if (!outgoing.writableEnded) {
          outgoing.writeHead(502, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: { message: "chaos proxy could not reach the real upstream" } }));
        }
      });
      incoming.on("data", (chunk: Buffer) => {
        this.stats.bytesUp += chunk.length;
      });
      incoming.pipe(upstreamRequest);
      outgoing.on("close", () => upstreamRequest.destroy());
    });
  }
}
