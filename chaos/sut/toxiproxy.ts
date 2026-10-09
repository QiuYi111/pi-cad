import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { del, get, httpJson, post, waitFor } from "./http.ts";
import { TOOLS_DIR, freePort, waitForLine } from "./proc.ts";

export interface ToxiproxyClient {
  readonly apiUrl: string;
  createProxy(name: string, listenPort: number, upstreamUrl: string): Promise<void>;
  deleteProxy(name: string): Promise<void>;
  addToxic(proxy: string, toxic: { name: string; type: string; stream?: string; attributes: Record<string, unknown> }): Promise<void>;
  removeToxic(proxy: string, name: string): Promise<void>;
  reset(): Promise<void>;
  stopProxy(name: string): Promise<void>;
  startProxy(name: string): Promise<void>;
  listToxics(proxy: string): Promise<{ name: string; type: string }[]>;
}

export function toxiproxyBinary(): string | null {
  const candidate = process.env.CHAOS_TOXIPROXY_BIN ?? path.join(TOOLS_DIR, "toxiproxy-server");
  return existsSync(candidate) ? candidate : null;
}

export function toxiproxyAvailable(): boolean {
  return toxiproxyBinary() !== null;
}

export function createToxiproxyClient(apiUrl: string): ToxiproxyClient {
  return {
    apiUrl,
    async createProxy(name, listenPort, upstreamUrl) {
      const upstream = new URL(upstreamUrl);
      try {
        await del(`${apiUrl}/proxies/${name}`);
      } catch {
        /* not present */
      }
      await post(`${apiUrl}/proxies`, {
        name,
        listen: `127.0.0.1:${listenPort}`,
        upstream: `${upstream.hostname}:${upstream.port}`,
        enabled: true,
      });
    },
    async deleteProxy(name) {
      await del(`${apiUrl}/proxies/${name}`);
    },
    async addToxic(proxy, toxic) {
      await del(`${apiUrl}/proxies/${proxy}/toxics/${toxic.name}`).catch(() => undefined);
      await post(`${apiUrl}/proxies/${proxy}/toxics`, { stream: "downstream", ...toxic });
    },
    async removeToxic(proxy, name) {
      await del(`${apiUrl}/proxies/${proxy}/toxics/${name}`).catch(() => undefined);
    },
    async reset() {
      await post(`${apiUrl}/reset`);
    },
    async stopProxy(name) {
      await post(`${apiUrl}/proxies/${name}`, { enabled: false });
    },
    async startProxy(name) {
      await post(`${apiUrl}/proxies/${name}`, { enabled: true });
    },
    async listToxics(proxy) {
      const body = await get<any>(`${apiUrl}/proxies/${proxy}/toxics`);
      const list: { name: string; type: string }[] = Array.isArray(body) ? body : (body?.toxics ?? []);
      return list.map((toxic) => ({ name: toxic.name, type: toxic.type }));
    },
  };
}

export interface ToxiproxyServer {
  apiUrl: string;
  client: ToxiproxyClient;
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Start a real Toxiproxy server from the cached upstream release binary. */
export async function startToxiproxyServer(): Promise<ToxiproxyServer> {
  const binary = toxiproxyBinary();
  if (!binary) throw new Error("toxiproxy-server binary not found; run `npm run chaos:fetch-tools`");
  const apiPort = await freePort();
  const child = spawn(binary, ["-host", "127.0.0.1", "-port", String(apiPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  try {
    await waitForLine(child, /Starting Toxiproxy HTTP server/, 15_000, () => stderr.join(""));
    await waitFor(
      async () => {
        try {
          const response = await httpJson("GET", `${apiUrl}/proxies`);
          return response.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 10_000, label: "toxiproxy api" },
    );
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    apiUrl,
    client: createToxiproxyClient(apiUrl),
    child,
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}
