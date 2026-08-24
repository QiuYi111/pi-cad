import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { FreshReviewExecutorV1, ReviewVerdictV1 } from "../../harness/review.ts";
import { CadProbeParametersSchema, executeCadProbe, type CadProbeParams } from "../../modules/probe/tool.ts";

function modelLabel(model: unknown): string {
  if (!model || typeof model !== "object") return "unavailable";
  const value = model as { provider?: string; id?: string; model?: string };
  return [value.provider, value.id ?? value.model].filter(Boolean).join("/") || "unknown";
}

function selectedModel(ctx: ExtensionContext): unknown | undefined {
  const requested = process.env.PI_CAD_REVIEWER_MODEL?.trim();
  if (requested) {
    const split = requested.indexOf("/");
    const found = split > 0 ? (ctx.modelRegistry as any)?.find?.(requested.slice(0, split), requested.slice(split + 1)) : undefined;
    if (found) return found;
  }
  return ctx.model;
}

function parseVerdict(messages: unknown[]): ReviewVerdictV1 | null {
  const message = (messages as Array<any>).filter((item) => item?.role === "assistant").at(-1);
  if (!message || message.stopReason !== "stop") return null;
  const text = (message.content ?? []).filter((item: any) => item.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n").trim();
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as ReviewVerdictV1; } catch { /* try fenced form */ }
  }
  return null;
}

function unresolved(summary: string): ReviewVerdictV1 {
  return { schema: 1, verdict: "unresolved", summary, findings: [{ id: "reviewer-unresolved", severity: "error", finding: summary, evidenceRefs: [] }] };
}

/** A fresh, extension-free reviewer session with one read-only Mechanical probe tool. */
export function mechanicalReviewExecutorV7(ctx: ExtensionContext): FreshReviewExecutorV1 {
  return {
    async execute(input) {
      if (input.allowedActions.length !== 1 || input.allowedActions[0] !== "cad_probe") throw new Error("Mechanical fresh reviewer action contract changed");
      const model = selectedModel(ctx);
      if (!model) return unresolved("reviewer model is unavailable");
      let probes = 0;
      const maxProbes = Number(process.env.PI_CAD_REVIEWER_MAX_PROBES ?? 12);
      const probe = defineTool({
        name: "cad_probe",
        label: "CAD Probe (v7 Fresh Reviewer)",
        description: "Read-only deterministic observation of the current immutable candidate.",
        parameters: CadProbeParametersSchema,
        execute: async (_toolCallId, raw) => {
          const params = raw as CadProbeParams;
          if (probes >= maxProbes) return { content: [{ type: "text" as const, text: "Reviewer probe budget exhausted." }], isError: true };
          if (params.subject && params.subject !== "current") return { content: [{ type: "text" as const, text: "Reviewer may probe only the current candidate." }], isError: true };
          const args = params.args ?? {};
          if (["artifact", "before", "after", "output"].some((key) => key in args)) return { content: [{ type: "text" as const, text: "Reviewer may not override subject paths." }], isError: true };
          probes += 1;
          return executeCadProbe(ctx.cwd, { ...params, subject: "current" });
        },
      });
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: [
          "You are a fresh independent Mechanical reviewer.",
          "Use only the supplied immutable contracts/evidence and cad_probe. Do not trust the author agent's conclusions.",
          "Return only ReviewVerdictV1 JSON: {schema:1,verdict:'pass|fail|unresolved',summary,findings:[{id,severity:'info|warning|error',finding,evidenceRefs:[]}]}",
          "PASS requires affirmative evidence for every acceptance requirement; uncertainty is UNRESOLVED.",
        ].join("\n"),
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: ctx.cwd, agentDir: getAgentDir(), model: model as never,
        thinkingLevel: (process.env.PI_CAD_REVIEWER_REASONING?.trim() || "medium") as never,
        tools: ["cad_probe"], customTools: [probe], resourceLoader,
        sessionManager: SessionManager.inMemory(ctx.cwd), settingsManager,
      });
      const timeoutMs = Number(process.env.PI_CAD_REVIEWER_TIMEOUT_MS ?? 120_000);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void created.session.abort(); }, timeoutMs);
      const abort = () => void created.session.abort();
      ctx.signal?.addEventListener("abort", abort, { once: true });
      try {
        await created.session.prompt(input.prompt, { expandPromptTemplates: false });
        if (timedOut) return unresolved(`reviewer timed out (${modelLabel(model)})`);
        return parseVerdict(created.session.messages as unknown[]) ?? unresolved("reviewer returned malformed or incomplete JSON");
      } catch (error) {
        return unresolved(`reviewer failed safely: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", abort);
        created.session.dispose();
      }
    },
  };
}
