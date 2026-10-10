// Provider / OAuth boundary: real credential copies, auth rejection and provider probes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "undici";
import { inspectReifyComponents } from "../chaos/reify/components.ts";
import { credentialAuthRejection, reifyFaultDefinitions } from "../chaos/reify/faults/index.ts";
import { inspectProviderBoundary, readProviderCredentials, resolvePrimeAgentRepo } from "../chaos/reify/inspect.ts";
import {
  applyCredentialFault,
  observeCredential,
  restoreCredentialSandbox,
  runTransportFault,
  seedCredentialSandbox,
} from "../chaos/reify/provider.ts";
import { injectReifyFault } from "../chaos/reify/runner.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { withRealSession } from "./chaos-reify-support.ts";

test("reify chaos: provider 边界读到真选择和凭证，且不泄露 token", async () => {
  const boundary = await inspectProviderBoundary({ probe: false });
  assert.ok(boundary.selection.provider.length > 0, "必须读到 provider 选择");
  assert.ok(boundary.selection.source.length > 0, "必须说明选择来源");
  assert.ok(Array.isArray(boundary.credentials));
  for (const credential of boundary.credentials) {
    assert.ok(!("access" in credential) && !("key" in credential), "凭证对象不能带 token 值");
    assert.equal(typeof credential.hasCredentials, "boolean");
  }
  if (resolvePrimeAgentRepo()) {
    // The real Prime model registry resolves a real endpoint for the selection.
    assert.ok(boundary.baseUrl === null || boundary.baseUrl.startsWith("http"), "baseUrl 必须是真 URL");
  }
});

test("reify chaos: provider 网络 probe 默认只读，只有显式 opt-in 才联网", async () => {
  const previous = process.env.CHAOS_REIFY_PROVIDER_PROBE;
  try {
    delete process.env.CHAOS_REIFY_PROVIDER_PROBE;
    // No call-site flag and no env opt-in: this must stay read-only and never
    // fire a real provider request.
    const byDefault = await inspectProviderBoundary();
    assert.equal(byDefault.probe.status, null, "默认不能发 provider 请求");
    assert.equal(byDefault.probe.ok, false);
    if (byDefault.probe.url) {
      assert.ok(byDefault.probe.skipped, "默认必须说明为什么没发请求");
    }
    // An explicit opt-out at the call site is also read-only.
    const forcedOff = await inspectProviderBoundary({ probe: false });
    assert.equal(forcedOff.probe.status, null, "显式关闭也不能发 provider 请求");
    // The shared component inspector keeps the same read-only default, so an
    // artifact capture can never trigger a real provider request.
    const session = await ReifySession.start();
    try {
      const components = await inspectReifyComponents(session);
      assert.equal(components.provider.probe.status, null, "capture 路径默认不能发 provider 请求");
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.CHAOS_REIFY_PROVIDER_PROBE;
    else process.env.CHAOS_REIFY_PROVIDER_PROBE = previous;
  }
});

test("reify chaos: 真 auth.json 格式（api_key / oauth）都算已认证，且不泄露 token", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-reify-auth-"));
  try {
    // The exact shapes Prime writes (docs/providers.md): API-key providers use
    // `type: "api_key"` + `key`, OAuth providers use `type: "oauth"` + `access`.
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        zai: { type: "api_key", key: "real-api-key-value" },
        "openai-codex": { type: "oauth", access: "real-access-value", refresh: "real-refresh-value", expires: 4102444800000 },
      }),
    );
    const credentials = readProviderCredentials(dir);
    const byId = new Map(credentials.map((credential) => [credential.id, credential]));
    assert.equal(byId.get("zai")?.type, "api_key");
    assert.equal(byId.get("zai")?.hasCredentials, true, "真 api_key 凭证必须算已认证");
    assert.equal(byId.get("openai-codex")?.type, "oauth");
    assert.equal(byId.get("openai-codex")?.hasCredentials, true, "真 oauth 凭证必须算已认证");
    for (const credential of credentials) {
      assert.ok(!("access" in credential) && !("key" in credential), "凭证对象不能带 token 值");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reify chaos: provider 边界对真 api_key 判为已认证，且默认只读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-reify-auth-"));
  try {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "real-api-key-value" } }));
    const boundary = await inspectProviderBoundary({ agentDir: dir, override: { provider: "zai", model: "glm-4.6" }, probe: false });
    assert.equal(boundary.probe.status, null, "默认只读，不能发请求");
    assert.equal(boundary.probe.authenticated, true, "真 api_key 凭证必须判为已认证（显式 probe 才会带真 header）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reify chaos: 凭证故障只在真 provider 明确 auth rejection 时才把 transport 失败算 NA", () => {
  // 已经实际跑过的探针失败，只有 401/403 才是「凭证坏了」这件事的真后果。
  assert.ok(credentialAuthRejection({ status: 401 }, "providerCredentialExpired"), "401 才允许 NA");
  assert.ok(credentialAuthRejection({ status: 403 }, "providerCredentialDropped"), "403 才允许 NA");
  assert.ok(credentialAuthRejection({ status: 401 }, "providerCredentialBlanked"), "清空 secret 后 provider 也会拒");

  // 200 但延迟没生效：真注入失败，旁边的凭证故障不能把它洗成 NA。
  assert.equal(
    credentialAuthRejection({ status: 200 }, "providerCredentialBlanked"),
    null,
    "200（延迟没生效）必须继续是 InjectionFailed",
  );
  assert.equal(credentialAuthRejection({ status: 500, error: "upstream 500" }, "providerCredentialExpired"), null);
  assert.equal(credentialAuthRejection({ status: null, error: "socket hang up" }, "providerCredentialDropped"), null);

  // 没有凭证故障时，401 同样是真失败，不能自己转成 NA。
  assert.equal(credentialAuthRejection({ status: 401 }, null), null, "没有凭证故障就不能 NA");
});

test("reify chaos: 真 provider 用 401 拒掉坏凭证才算 NA，带好凭证的真延迟仍然是真注入", async () => {
  const upstream = createServer((incoming, outgoing) => {
    const authorized = incoming.headers.authorization === "Bearer good";
    outgoing.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ok: authorized, auth: incoming.headers.authorization ?? null }));
  });
  await new Promise<void>((accept) => upstream.listen(0, "127.0.0.1", () => accept()));
  const port = (upstream.address() as { port: number }).port;
  try {
    // 凭证故障把凭证改坏，探针带着坏 header 打真上游：上游明确 401，
    // transport 故障就打不上，这个 NA 记在凭证故障头上是对的。
    const rejected = await runTransportFault({
      baseUrl: `http://127.0.0.1:${port}`,
      plan: { mode: "latency", delayMs: 1_500 },
      authHeaders: { authorization: "Bearer broken" },
      timeoutMs: 2_000,
    });
    assert.equal(rejected.status, 401, "坏凭证必须被真 provider 明确拒掉");
    assert.ok(credentialAuthRejection(rejected, "providerCredentialBlanked"), "明确 auth rejection 才允许 NA");
    assert.equal(credentialAuthRejection(rejected, null), null, "没有凭证故障时同样不能 NA");

    // 凭证没被改坏：真延迟真的生效，旁边就算挂着凭证故障也不能动它。
    const landed = await runTransportFault({
      baseUrl: `http://127.0.0.1:${port}`,
      plan: { mode: "latency", delayMs: 300 },
      authHeaders: { authorization: "Bearer good" },
      timeoutMs: 2_000,
    });
    assert.equal(landed.status, 200, "带好凭证必须拿到真答案");
    assert.ok(landed.ms >= 300 * 0.8, `延迟必须真生效（${landed.ms}ms）`);
    assert.equal(credentialAuthRejection(landed, "providerCredentialBlanked"), null, "真打上的探针不能被洗成 NA");
  } finally {
    upstream.closeAllConnections?.();
    await new Promise<void>((accept) => upstream.close(() => accept()));
  }
});

test("reify chaos: 真 credential 副本过期 / 删除 / 清空后，真读取代码判成不可用", async () => {
  const source = mkdtempSync(join(tmpdir(), "chaos-reify-cred-"));
  const session = await ReifySession.start();
  try {
    writeFileSync(
      join(source, "auth.json"),
      JSON.stringify({
        zai: { type: "api_key", key: "real-api-key-value" },
        "openai-codex": { type: "oauth", access: "real-access-value", expires: 4102444800000 },
      }),
    );
    const selection = { provider: "openai-codex", model: "gpt-5" };

    const expired = seedCredentialSandbox(session, source);
    const expiredResult = await applyCredentialFault(expired, selection, "expire");
    assert.equal(expiredResult.before.expired, false, "真 OAuth 凭证一开始没过期");
    assert.equal(expiredResult.after.expired, true, "过期故障之后真读取代码必须判成已过期");
    restoreCredentialSandbox(expired);
    const restored = await observeCredential(expired, selection);
    assert.equal(restored.described.expired, false, "恢复之后必须回到没过期");

    const dropped = seedCredentialSandbox(session, source);
    const droppedResult = await applyCredentialFault(dropped, selection, "drop");
    assert.equal(droppedResult.before.present, true);
    assert.equal(droppedResult.after.present, false, "删除故障之后凭证不能还在");
    restoreCredentialSandbox(dropped);

    const blanked = seedCredentialSandbox(session, source);
    const blankedResult = await applyCredentialFault(blanked, { provider: "zai", model: "glm-4.6" }, "blank");
    assert.equal(blankedResult.after.hasCredentials, false, "清空 secret 之后不能还算已认证");
    restoreCredentialSandbox(blanked);
  } finally {
    await session.close().catch(() => undefined);
    rmSync(source, { recursive: true, force: true });
  }
});

test("reify chaos: 凭证副本里没有选中的 provider 时，凭证故障明说不适用而不是乱打", async () => {
  const previous = { provider: process.env.CHAOS_REIFY_PROVIDER, model: process.env.CHAOS_REIFY_MODEL };
  await withRealSession(async (session, trace) => {
    // Force a selection the chaos-owned credential copy cannot have.
    process.env.CHAOS_REIFY_PROVIDER = "chaos-provider-that-does-not-exist";
    process.env.CHAOS_REIFY_MODEL = "chaos-model";
    const definition = reifyFaultDefinitions.find((fault) => fault.name === "providerCredentialDropped")!;
    const outcome = await injectReifyFault(session, definition, { kind: "fault", name: definition.name, params: {} }, trace);
    assert.equal(outcome.status, "NotApplicable", `不能乱打：${JSON.stringify(outcome)}`);
    assert.ok(outcome.reason && outcome.reason.length > 0, "不适用必须给理由");
    assert.ok(!session.activeFaults.includes(definition.name), "不适用就不能留在已注入状态");
  });
  if (previous.provider === undefined) delete process.env.CHAOS_REIFY_PROVIDER;
  else process.env.CHAOS_REIFY_PROVIDER = previous.provider;
  if (previous.model === undefined) delete process.env.CHAOS_REIFY_MODEL;
  else process.env.CHAOS_REIFY_MODEL = previous.model;
});

test("reify chaos: 没有显式 override 时，凭证故障也认得机器自己的真选择", async () => {
  const source = mkdtempSync(join(tmpdir(), "chaos-reify-cred-select-"));
  const session = await ReifySession.start();
  try {
    writeFileSync(join(source, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "real-api-key-value" } }));
    writeFileSync(join(source, "settings.json"), JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" }));

    // An empty override is what a campaign round really passes. Looking the
    // credential up by the *input* selection instead of the resolved one
    // returned `undefined`, so every credential fault quietly reported
    // "凭证副本里没有可打的 provider" and the whole provider/OAuth boundary
    // was never really exercised.
    const sandbox = seedCredentialSandbox(session, source);
    const observed = await observeCredential(sandbox, {});
    assert.equal(observed.boundary.selection.provider, "zai", "必须用机器自己的选择");
    assert.equal(observed.described.present, true, "机器自己的凭证必须被认出来");
    assert.equal(observed.described.hasCredentials, true);
  } finally {
    await session.close().catch(() => undefined);
    rmSync(source, { recursive: true, force: true });
  }
});
