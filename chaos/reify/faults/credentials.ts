/** Provider / OAuth boundary: real credential copies expired, dropped or blanked. */

import fc from "fast-check";
import { InvariantViolation } from "../../types.ts";
import { FaultNotApplicable } from "../types.ts";
import type { Params, ReifyContext, ReifyFaultDefinition } from "../types.ts";
import { applyCredentialFault, credentialSandboxPresent, seedCredentialSandbox } from "../provider.ts";
import type { CredentialSandbox } from "../provider.ts";

// Provider / OAuth
// ---------------------------------------------------------------------------

/** A chaos-owned copy of the real credential store, shared by provider faults. */
export function providerSandbox(ctx: ReifyContext): CredentialSandbox {
  const existing = ctx.session.armedFaults.get("__providerSandbox") as CredentialSandbox | undefined;
  if (existing) return existing;
  const sandbox = seedCredentialSandbox(ctx.session);
  ctx.session.armedFaults.set("__providerSandbox", sandbox);
  return sandbox;
}

/**
 * Only pass a real override. Pushing the placeholder "unknown" through would
 * make the resolver treat it as a real selection and never read the machine's
 * own settings.
 */
export function providerSelection(): { provider?: string; model?: string } {
  const override: { provider?: string; model?: string } = {};
  if (process.env.CHAOS_REIFY_PROVIDER) override.provider = process.env.CHAOS_REIFY_PROVIDER;
  if (process.env.CHAOS_REIFY_MODEL) override.model = process.env.CHAOS_REIFY_MODEL;
  return override;
}

export async function resolveProviderForFault(
  ctx: ReifyContext,
): Promise<{ selection: { provider: string; model: string }; described: { present: boolean; hasCredentials: boolean; expired: boolean | null } } | null> {
  const cached = await ctx.session.armedFaults.get("__providerSelection");
  if (cached) {
    return cached as { selection: { provider: string; model: string }; described: { present: boolean; hasCredentials: boolean; expired: boolean | null } };
  }
  const { boundary: observed, described } = await (await import("../provider.ts")).observeCredential(
    providerSandbox(ctx),
    providerSelection(),
  );
  if (observed.selection.provider === "unknown" || !described.present) return null;
  const resolved = { selection: { provider: observed.selection.provider, model: observed.selection.model }, described };
  ctx.session.armedFaults.set("__providerSelection", resolved);
  return resolved;
}

export function credentialFault(name: string, fault: "expire" | "drop" | "blank"): ReifyFaultDefinition {
  return {
    name,
    description:
      fault === "expire"
        ? "把真 schema 的 OAuth 凭证改成已过期，看真读取代码怎么判"
        : fault === "drop"
          ? "把选中 provider 的凭证从真 schema 副本里删掉"
          : "把选中 provider 的凭证 secret 清空",
    arbitrary: fc.constant<Params>({}),
    describe: () => name,
    precondition: async (ctx) => {
      const sandbox = providerSandbox(ctx);
      if (!credentialSandboxPresent(sandbox)) return { applicable: false, reason: "本机没有真 credentials（~/.prime/agent/auth.json）" };
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) return { applicable: false, reason: "凭证副本里没有可打的 provider（读不到选择或没这条凭证）" };
      return { applicable: true, evidence: { dir: sandbox.dir, provider: resolved.selection.provider, files: sandbox.files } };
    },
    inject: async (ctx) => {
      const sandbox = providerSandbox(ctx);
      const resolved = await resolveProviderForFault(ctx);
      if (!resolved) throw new FaultNotApplicable("凭证副本里没有可打的 provider");
      const { selection, described: before } = resolved;
      const result = await applyCredentialFault(sandbox, selection, fault);
      // Recovery must land back on exactly the state we started from, even if
      // the machine's own credential was already unusual.
      ctx.session.armedFaults.set(name, { sandbox, selection, before });
      ctx.session.armFault(name);
      ctx.trace.record({ kind: "note", name, detail: { provider: result.provider, before: result.before, after: result.after } });
    },
    recover: async (ctx) => {
      const armed = ctx.session.armedFaults.get(name) as
        | { sandbox: CredentialSandbox; selection: { provider: string; model: string }; before: { present: boolean; hasCredentials: boolean; expired: boolean | null } }
        | undefined;
      ctx.session.disarmFault(name);
      if (!armed) return;
      const { restoreCredentialSandbox, observeCredential } = await import("../provider.ts");
      restoreCredentialSandbox(armed.sandbox);
      const back = await observeCredential(armed.sandbox, armed.selection);
      if (JSON.stringify(back.described) !== JSON.stringify(armed.before)) {
        throw new InvariantViolation("recovery-convergence", `${name} 之后凭证没有回到原来的状态`, {
          provider: armed.selection.provider,
          before: armed.before,
          after: back.described,
        });
      }
      ctx.trace.note(`凭证副本已还原：${armed.selection.provider} hasCredentials=${back.described.hasCredentials}`);
    },
  };
}

/**
 * A transport fault only counts as injected when the client really saw the
 * thing we meant to inject. "Returned 200 anyway" is a failed injection, not a
 * passing step.
 */
export const CREDENTIAL_FAULT_NAMES = ["providerCredentialExpired", "providerCredentialDropped", "providerCredentialBlanked"];

/** The credential fault this round is still holding, if any. */
export function credentialFaultArmed(ctx: ReifyContext): string | null {
  return ctx.session.activeFaults.find((name) => CREDENTIAL_FAULT_NAMES.includes(name)) ?? null;
}

/**
 * A real provider refusing the credential: 401 / 403. This is the only
 * transport-probe answer a credential fault is allowed to explain away.
 */
export const AUTH_REJECTION_STATUSES = new Set([401, 403]);

/**
 * Does an already-executed transport probe failure really belong to the
 * credential fault armed in this round?
 *
 * Only when the real provider answered with an explicit auth rejection
 * (401/403) does the probe failure say "the credential is broken", which is
 * exactly what the credential fault did -- and never a transport finding.
 * Then, and only then, it is honestly NotApplicable. Everything else the
 * probe really saw (a 200 that arrived too fast, a wrong status code, a hang
 * that never hung) stays a real InjectionFailed, so a credential fault armed
 * nearby can never launder a real transport failure into "did not apply".
 */
export function credentialAuthRejection(
  result: { status: number | null; error?: string },
  credentialFault: string | null,
): string | null {
  if (!credentialFault) return null;
  if (result.status === null || !AUTH_REJECTION_STATUSES.has(result.status)) return null;
  return `本轮挂着凭证故障 ${credentialFault}，真 provider 明确拒了这个凭证（status=${result.status}），传输探针打不实；这是凭证故障自己的后果，不是传输故障`;
}

export const providerCredentialExpired = credentialFault("providerCredentialExpired", "expire");
export const providerCredentialDropped = credentialFault("providerCredentialDropped", "drop");
export const providerCredentialBlanked = credentialFault("providerCredentialBlanked", "blank");
