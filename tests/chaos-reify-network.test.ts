// Network / proxy boundary: real provider fault proxy timeouts, resets, latency, cuts and status codes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { request } from "undici";
import { parseUpstream, ProviderFaultProxy } from "../chaos/reify/provider-proxy.ts";

test("reify chaos: 真 provider fault proxy 的 timeout/reset/latency/截断/状态码都是真的", async () => {
  const upstream = createServer((incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true, path: incoming.url }));
  });
  await new Promise<void>((accept) => upstream.listen(0, "127.0.0.1", () => accept()));
  const port = (upstream.address() as { port: number }).port;
  const upstreamConfig = { protocol: "http" as const, host: "127.0.0.1", port };
  try {
    // Baseline: no fault -> the real upstream answer comes back through the proxy.
    const clean = await ProviderFaultProxy.start(upstreamConfig, { mode: "latency", delayMs: 0 });
    const cleanResponse = await request(clean.urlFor("/models"));
    assert.equal(cleanResponse.statusCode, 200);
    await cleanResponse.body.dump();
    await clean.close();

    // timeout/hang: the client's own timeout is what fails.
    const hung = await ProviderFaultProxy.start(upstreamConfig, { mode: "hang" });
    await assert.rejects(() => request(hung.urlFor("/models"), { headersTimeout: 300, bodyTimeout: 300 }));
    assert.equal(hung.observations.faults, 1);
    await hung.close();

    // reset: a real RST, not a clean EOF.
    const reset = await ProviderFaultProxy.start(upstreamConfig, { mode: "reset" });
    await assert.rejects(
      () => request(reset.urlFor("/models")),
      (error: unknown) => /reset|socket hang up|other side closed/i.test(String((error as Error).message)),
    );
    await reset.close();

    // truncated stream: prefix of the real body, then the connection breaks.
    const cut = await ProviderFaultProxy.start(upstreamConfig, { mode: "truncate", bytes: 4 });
    const cutResponse = await request(cut.urlFor("/models"));
    assert.equal(cutResponse.statusCode, 200);
    await assert.rejects(() => cutResponse.body.arrayBuffer());
    assert.equal(cut.observations.faults, 1);
    await cut.close();

    // status fault: a real HTTP status code reaches the caller.
    const limited = await ProviderFaultProxy.start(upstreamConfig, { mode: "status", status: 429 });
    const limitedResponse = await request(limited.urlFor("/models"));
    assert.equal(limitedResponse.statusCode, 429);
    await limitedResponse.body.dump();
    await limited.close();
  } finally {
    upstream.closeAllConnections?.();
    await new Promise<void>((accept) => upstream.close(() => accept()));
  }
});

test("reify chaos: provider fault proxy 不能把 provider 的 base path 吃掉", async () => {
  // 真 provider 的 endpoint 带路径前缀（例如 https://api.z.ai/api/coding/paas/v4）。
  // 代理只留 host/port 时，`/models` 会被转发到 https://api.z.ai/models —— 上游回
  // 404，于是 latency 这类「必须看到真上游回答才算注入成功」的故障永远打不上，
  // 每轮只能诚实报 InjectionFailed。这里盯住转发出去的真路径。
  const seen: string[] = [];
  const upstream = createServer((incoming, outgoing) => {
    seen.push(incoming.url ?? "");
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: true, path: incoming.url }));
  });
  await new Promise<void>((accept) => upstream.listen(0, "127.0.0.1", () => accept()));
  const port = (upstream.address() as { port: number }).port;
  const upstreamConfig = { protocol: "http" as const, host: "127.0.0.1", port };
  try {
    assert.equal(parseUpstream("https://api.z.ai/api/coding/paas/v4").basePath, "/api/coding/paas/v4");
    assert.equal(parseUpstream("https://api.example.com/").basePath, "", "根路径不能再挂一层 /");

    const proxy = await ProviderFaultProxy.start({ ...upstreamConfig, basePath: "/api/coding/paas/v4" }, { mode: "latency", delayMs: 0 });
    const response = await request(proxy.urlFor("/models"));
    assert.equal(response.statusCode, 200, "带上 base path 之后上游要给真答案");
    await response.body.dump();
    await proxy.close();
    assert.deepEqual(seen, ["/api/coding/paas/v4/models"], "转发给真 provider 的路径必须带前缀");
  } finally {
    upstream.closeAllConnections?.();
    await new Promise<void>((accept) => upstream.close(() => accept()));
  }
});
