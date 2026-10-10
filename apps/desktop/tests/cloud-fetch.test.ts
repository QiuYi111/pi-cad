import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent } from "undici";
import { bypassCloudProxy, cloudFetch } from "../electron/main/cloud-fetch";

const originalDispatcher = getGlobalDispatcher();
let proxy: ProxyAgent | undefined;
afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await proxy?.close();
  proxy = undefined;
});

describe("cloud requests with an inherited proxy", () => {
  it("uses direct routing for Tailnet endpoints without matching lookalike domains", () => {
    expect(bypassCloudProxy("desktop-pkr2go0.tailb53649.ts.net")).toBe(true);
    expect(bypassCloudProxy("desktop-pkr2go0.tailb53649.ts.net.example.com")).toBe(false);
    expect(bypassCloudProxy("example.com")).toBe(false);
  });

  it("still reaches a local cloud API when the global proxy is unreachable", async () => {
    const server = createServer((_request, response) => response.end(JSON.stringify({ ok: true })));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    const url = `http://127.0.0.1:${address.port}/v1/healthz`;
    proxy = new ProxyAgent("http://127.0.0.1:1");
    setGlobalDispatcher(proxy);
    try {
      await expect(fetch(url)).rejects.toThrow();
      const response = await cloudFetch(new Request(url));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the configured proxy for other server domains", async () => {
    proxy = new ProxyAgent("http://127.0.0.1:1");
    setGlobalDispatcher(proxy);
    const error = await cloudFetch("http://example.invalid/v1/healthz").catch(error => error);
    expect(error.cause.code).toBe("ECONNREFUSED");
    expect(error.cause.address).toBe("127.0.0.1");
  });
});
