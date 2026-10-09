/** Network / proxy boundary: provider timeouts, resets, latency, cuts and HTTP errors through the fault proxy. */

import fc from "fast-check";
import { FaultNotApplicable } from "../types.ts";
import type { Params, ReifyFaultDefinition } from "../types.ts";
import { providerFaultsEnabled, runTransportFault, transportTarget } from "../provider.ts";
import { providerSandbox, resolveProviderForFault, credentialFaultArmed, credentialAuthRejection } from "./credentials.ts";

function assertTransportFaultLanded(
  name: string,
  plan: { mode: "latency" | "hang" | "reset" | "truncate" | "status"; delayMs?: number; status?: number },
  result: { status: number | null; ok: boolean; ms: number; error?: string },
): void {
  const failed = (why: string): never => {
    throw new Error(`${name} 没打上：${why}`);
  };
  switch (plan.mode) {
    case "hang":
      if (!result.error) failed(`客户端没有被自己的超时打断（status=${result.status}）`);
      return;
    case "reset":
      if (!result.error) failed(`连接没被重置（status=${result.status}）`);
      return;
    case "truncate":
      if (!result.error) failed(`响应没被截断（status=${result.status}）`);
      return;
    case "status":
      if (result.status !== (plan.status ?? 500)) failed(`状态码是 ${result.status}，不是 ${plan.status}`);
      return;
    case "latency":
      if (!result.ok) failed(`加了延迟之后请求反而失败：${result.error ?? result.status}`);
      if (result.ms < (plan.delayMs ?? 0) * 0.8) failed(`延迟没生效（${result.ms}ms 小于 ${plan.delayMs}ms）`);
      return;
  }
}

function transportFault(
  name: string,
  plan: { mode: "latency" | "hang" | "reset" | "truncate" | "status"; delayMs?: number; bytes?: number; status?: number },
): ReifyFaultDefinition {
  return {
    name,
    description: `真 provider 端点上注入 ${plan.mode} 传输故障（走真 fault proxy，带真凭证 header）`,
    arbitrary: fc.constant<Params>({}),
    describe: () => name,
    precondition: async (ctx) => {
      if (!providerFaultsEnabled()) {
        return { applicable: false, reason: "provider 网络故障是显式 opt-in（CHAOS_REIFY_PROVIDER_FAULTS=1）" };
      }
      const sandbox = providerSandbox(ctx);
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) return { applicable: false, reason: "凭证副本里没有可打的 provider" };
      const target = await transportTarget(sandbox, resolved.selection);
      if (!target) return { applicable: false, reason: "解析不出真 provider endpoint（没有 prime-agent 模型注册表）" };
      return { applicable: true, evidence: { endpoint: target.baseUrl, provider: resolved.selection.provider } };
    },
    inject: async (ctx) => {
      const sandbox = providerSandbox(ctx);
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) throw new FaultNotApplicable("凭证副本里没有可打的 provider");
      const target = await transportTarget(sandbox, resolved.selection);
      if (!target) throw new FaultNotApplicable("解析不出真 provider endpoint");
      const result = await runTransportFault({
        baseUrl: target.baseUrl,
        plan,
        authHeaders: target.authHeaders,
        timeoutMs: Number(process.env.CHAOS_REIFY_PROVIDER_TIMEOUT_MS ?? 2_500),
      });
      try {
        assertTransportFaultLanded(name, plan, result);
      } catch (error) {
        // A credential fault armed in the same round really can make the real
        // provider reject the probe: with the credential expired / blanked /
        // dropped the endpoint answers 401 (or 403), and the transport fault
        // then "did not land" because the harness itself broke the credential.
        // That one answer is the credential fault talking, not a transport
        // failure, so it is honestly NotApplicable. Every other probe failure
        // stays a real InjectionFailed -- a credential fault armed nearby must
        // never turn a real transport-injection failure into "did not apply".
        const credential = credentialFaultArmed(ctx);
        const rejection = credentialAuthRejection(result, credential);
        if (rejection) {
          throw new FaultNotApplicable(rejection, { credential, status: result.status, mode: plan.mode });
        }
        throw error;
      }
      ctx.session.armFault(name);
      ctx.session.armedFaults.set(name, { result });
      ctx.trace.record({ kind: "note", name, detail: result });
    },
    recover: async (ctx) => {
      ctx.session.disarmFault(name);
      ctx.trace.note(`${name} 结束，fault proxy 已关闭`);
    },
  };
}

export const providerTimeout = transportFault("providerTimeout", { mode: "hang" });
export const providerReset = transportFault("providerReset", { mode: "reset" });
export const providerLatency = transportFault("providerLatency", { mode: "latency", delayMs: 1_500 });
export const providerStreamCut = transportFault("providerStreamCut", { mode: "truncate", bytes: 32, delayMs: 50 });
export const providerRateLimited = transportFault("providerRateLimited", { mode: "status", status: 429 });
export const providerServerError = transportFault("providerServerError", { mode: "status", status: 503 });
