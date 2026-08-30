import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readImageContents } from "../../shared/capability.ts";
import type {
  CadRequirements,
  CadRunState,
  FinalReviewResult,
} from "../../shared/protocol.ts";
import { CadProbeParametersSchema, executeCadProbe, type CadProbeParams } from "../../modules/probe/tool.ts";
import type { FinalReviewPreflightResult } from "./preflight.ts";
import {
  collectReviewerEvidenceIndex,
  renderReviewerEvidenceIndex,
  type ReviewerEvidenceIndex,
} from "./evidence-index.ts";

export const REVIEWER_PROMPT_VERSION = "fresh-reviewer-v1";

interface ReviewerResponse {
  content?: Array<Record<string, unknown>>;
  stopReason?: string;
  usage?: unknown;
  model?: string;
}

export interface ReviewerRunOutput {
  result: FinalReviewResult;
  evidenceIndex: ReviewerEvidenceIndex;
  probeCalls: number;
  usage: unknown[];
  reviewerModel: string;
  probeEvidence: Array<{
    ref: string;
    arguments: CadProbeParams;
    text: string;
    details?: unknown;
  }>;
}

export interface ReviewerRunner {
  run(
    ctx: ExtensionContext,
    state: CadRunState,
    requirements: CadRequirements,
    preflight: FinalReviewPreflightResult,
  ): Promise<ReviewerRunOutput>;
}

export interface RequirementsReviewRunOutput {
  result: FinalReviewResult;
  usage: unknown[];
  reviewerModel: string;
  sourceRefs: string[];
}

export interface RequirementsReviewerRunner {
  run(
    ctx: ExtensionContext,
    state: CadRunState,
    requirements: CadRequirements,
  ): Promise<RequirementsReviewRunOutput>;
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveReviewerModel(ctx: ExtensionContext): unknown | undefined {
  const spec = process.env.PI_CAD_REVIEWER_MODEL?.trim();
  const registry = ctx.modelRegistry as unknown as {
    find?: (provider: string, modelId: string) => unknown | undefined;
  };
  if (spec) {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const selected = registry.find?.(spec.slice(0, slash), spec.slice(slash + 1));
      if (selected) return selected;
    }
  }
  return ctx.model;
}

function modelLabel(model: unknown): string {
  if (!model || typeof model !== "object") return "unavailable";
  const value = model as { provider?: string; id?: string; model?: string };
  return [value.provider, value.id ?? value.model].filter(Boolean).join("/") || "unknown";
}

function reviewerReasoning(): string | undefined {
  const raw = process.env.PI_CAD_REVIEWER_REASONING?.trim().toLowerCase() ?? "medium";
  return raw === "off" || raw === "none" ? undefined : raw;
}

function reviewerProbeAllowed(params: CadProbeParams): string | null {
  if (params.subject && params.subject !== "current") return "reviewer may probe only the current candidate";
  if (params.preset === "compare") return "reviewer compare probes are disabled; use the current compare evidence index";
  const args = params.args ?? {};
  for (const key of ["artifact", "before", "after", "output"]) {
    if (key in args) return `reviewer cad_probe args may not set ${key}`;
  }
  return null;
}

function finalJsonFromResponse(response: ReviewerResponse): FinalReviewResult | null {
  const text = (response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [text, fenced].filter((item): item is string => Boolean(item))) {
    try {
      return JSON.parse(candidate) as FinalReviewResult;
    } catch {
      // try the other representation
    }
  }
  return null;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is { type: string; text: string } =>
      Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n");
}

function requirementsSourceMessages(ctx: ExtensionContext): Array<{ ref: string; text: string }> {
  const messages = ctx.sessionManager?.getBranch?.() ?? [];
  const userMessages = messages.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const text = textContent(entry.message.content).trim();
    return text ? [text] : [];
  });
  // Requirements are reviewed early, but retain a bounded tail for interactive
  // clarification turns without feeding an entire unrelated session to the judge.
  return userMessages.slice(-8).map((text, index, selected) => ({
    ref: `user:${userMessages.length - selected.length + index + 1}`,
    text: text.slice(0, 8_000),
  }));
}

function unresolvedResult(requirements: CadRequirements, summary: string): FinalReviewResult {
  return {
    verdict: "unresolved",
    assertionChecks: requirements.assertions.map((assertion) => ({
      assertionId: assertion.id,
      verdict: "unresolved",
      finding: summary,
      evidenceRefs: [],
    })),
    semanticObjections: [],
    summary,
  };
}

export function validateFinalReviewResult(
  candidate: FinalReviewResult,
  requirements: CadRequirements,
  knownEvidenceRefs: Set<string>,
): string | null {
  if (!candidate || !["pass", "fail", "unresolved"].includes(candidate.verdict)) {
    return "review verdict must be pass, fail, or unresolved";
  }
  if (!Array.isArray(candidate.assertionChecks) || !Array.isArray(candidate.semanticObjections)) {
    return "review result arrays are missing";
  }
  const expected = requirements.assertions.map((item) => item.id).sort();
  const actual = candidate.assertionChecks.map((item) => item.assertionId).sort();
  if (actual.length !== new Set(actual).size || JSON.stringify(actual) !== JSON.stringify(expected)) {
    return "review must cover every assertion exactly once";
  }
  for (const check of candidate.assertionChecks) {
    if (!check || typeof check.finding !== "string" || !Array.isArray(check.evidenceRefs)) {
      return `malformed assertion check for ${check?.assertionId ?? "unknown"}`;
    }
    if (!["pass", "fail", "unresolved", "binding_suspect"].includes(check.verdict)) {
      return `invalid verdict for assertion ${check.assertionId}`;
    }
    if (check.verdict === "pass" && (!Array.isArray(check.evidenceRefs) || check.evidenceRefs.length === 0)) {
      return `PASS for ${check.assertionId} requires evidence`;
    }
    for (const ref of check.evidenceRefs) {
      if (typeof ref !== "string") return `malformed evidence ref for ${check.assertionId}`;
      if (!knownEvidenceRefs.has(ref)) return `unknown evidence ref: ${ref}`;
    }
  }
  for (const objection of candidate.semanticObjections) {
    if (!objection || typeof objection.mustRef !== "string" || typeof objection.finding !== "string" || !Array.isArray(objection.evidenceRefs)) {
      return "malformed semantic objection";
    }
    for (const ref of objection.evidenceRefs) {
      if (typeof ref !== "string") return `malformed evidence ref for ${objection.mustRef}`;
      if (!knownEvidenceRefs.has(ref)) return `unknown evidence ref: ${ref}`;
    }
  }
  const hasFailure = candidate.assertionChecks.some((check) =>
    check.verdict === "fail" || check.verdict === "binding_suspect",
  );
  const hasUnresolved = candidate.assertionChecks.some((check) => check.verdict === "unresolved");
  if (candidate.verdict === "pass" && (hasFailure || hasUnresolved || candidate.semanticObjections.length > 0)) {
    return "overall PASS conflicts with assertion checks or semantic objections";
  }
  if (candidate.verdict === "fail" && !hasFailure && candidate.semanticObjections.length === 0) {
    return "overall FAIL has no failing check or objection";
  }
  return null;
}

async function initialMessage(
  cwd: string,
  state: CadRunState,
  requirements: CadRequirements,
  preflight: FinalReviewPreflightResult,
  evidenceIndex: ReviewerEvidenceIndex,
) {
  const text = [
    "# Canonical Mission",
    `Goal: ${requirements.goal}`,
    "Must:",
    ...requirements.must.map((must, index) => `M${index + 1}: ${must}`),
    "Assumptions (provisional):",
    ...(requirements.assumptions.length ? requirements.assumptions : ["(none)"]),
    "Open unknowns:",
    ...(requirements.openUnknowns.length ? requirements.openUnknowns : ["(none)"]),
    "Headless clarification debt:",
    ...((state.deferredClarifications?.length || requirements.deferredClarifications?.length)
      ? (state.deferredClarifications ?? requirements.deferredClarifications ?? []).map((item) => JSON.stringify(item))
      : ["(none)"]),
    "# Pre-registered Assertions",
    JSON.stringify(requirements.assertions, null, 2),
    "# Current candidate",
    `artifact: ${state.currentArtifactPath ?? "unbound"}`,
    `artifactHash: ${state.currentArtifactHash ?? "unbound"}`,
    "# Deterministic global digest",
    JSON.stringify(preflight.digest, null, 2),
    "# Deterministic artifact integrity",
    JSON.stringify(preflight.artifactIntegrity, null, 2),
    "# Deterministic preflight checks",
    JSON.stringify(preflight.checks.map((check) => ({
      ...check,
      evidenceRef: `preflight:${check.assertionId}`,
    })), null, 2),
    "# Existing current evidence",
    renderReviewerEvidenceIndex(evidenceIndex),
    "# Required output",
    "Return only one FinalReviewResult JSON object. Evidence refs must be copied exactly from the index, preflight:<assertionId>, or cad_probe tool results.",
  ].join("\n");
  const images = evidenceIndex.visualPaths.length
    ? await readImageContents(evidenceIndex.visualPaths.map((path) => resolve(cwd, path)))
    : [];
  return { text, images };
}

export async function runFreshReviewer(
  ctx: ExtensionContext,
  state: CadRunState,
  requirements: CadRequirements,
  preflight: FinalReviewPreflightResult,
): Promise<ReviewerRunOutput> {
  const model = resolveReviewerModel(ctx);
  const reviewerModel = modelLabel(model);
  const evidenceIndex = collectReviewerEvidenceIndex(state);
  if (!model) {
    return { result: unresolvedResult(requirements, "reviewer model is unavailable"), evidenceIndex, probeCalls: 0, usage: [], reviewerModel, probeEvidence: [] };
  }
  const systemPrompt = await readFile(
    fileURLToPath(new URL("../../prompts/final_verifier.md", import.meta.url)),
    "utf-8",
  );
  const initial = await initialMessage(ctx.cwd, state, requirements, preflight, evidenceIndex);
  const knownEvidenceRefs = new Set(evidenceIndex.items.map((item) => item.ref));
  knownEvidenceRefs.add(preflight.artifactIntegrity.evidenceRef);
  for (const check of preflight.checks) knownEvidenceRefs.add(`preflight:${check.assertionId}`);
  const maxProbes = envInt("PI_CAD_REVIEWER_MAX_PROBES", 12);
  const maxTurns = envInt("PI_CAD_REVIEWER_MAX_TURNS", 16);
  const timeoutMs = envInt("PI_CAD_REVIEWER_TIMEOUT_MS", 120_000);
  const usage: unknown[] = [];
  const probeEvidence: ReviewerRunOutput["probeEvidence"] = [];
  let probeCalls = 0;
  let timedOut = false;
  let turnBudgetExhausted = false;
  let turns = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const probeTool = defineTool({
      name: "cad_probe",
      label: "CAD Probe (Final Reviewer)",
      description: "Read-only deterministic observation of the current immutable CAD artifact.",
      parameters: CadProbeParametersSchema,
      execute: async (_toolCallId, params) => {
        const probeRestriction = reviewerProbeAllowed(params as CadProbeParams);
        if (probeRestriction) {
          return {
            content: [{ type: "text" as const, text: `Tool call rejected: ${probeRestriction}.` }],
            details: { rejected: true },
            isError: true,
          };
        }
        if (probeCalls >= maxProbes) {
          return {
            content: [{ type: "text" as const, text: "Tool call rejected: reviewer probe budget exhausted." }],
            details: { rejected: true, budgetExhausted: true },
            isError: true,
          };
        }
        probeCalls += 1;
        const result = await executeCadProbe(ctx.cwd, {
          ...(params as CadProbeParams),
          subject: "current",
        });
        const failed = (result.details as { presetFailed?: boolean } | undefined)?.presetFailed === true ||
          (result.content ?? []).some((item) => item.type === "text" && /cad_probe.*failed:/i.test(item.text ?? ""));
        const evidenceRef = failed ? `probe-attempt:${probeCalls}` : `probe:${probeCalls}`;
        if (!failed) knownEvidenceRefs.add(evidenceRef);
        probeEvidence.push({
          ref: evidenceRef,
          arguments: params as CadProbeParams,
          text: (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"),
          details: result.details,
        });
        return {
          content: [
            { type: "text", text: failed
              ? `This probe failed and produced no valid evidence ref (attempt ${evidenceRef}).`
              : `Evidence ref for this observation: ${evidenceRef}` },
            ...(result.content ?? []),
          ],
          details: { ...(result.details ?? {}), evidenceRef },
          isError: failed,
        };
      },
    });
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model: model as never,
      thinkingLevel: (reviewerReasoning() ?? "off") as never,
      tools: ["cad_probe"],
      customTools: [probeTool],
      resourceLoader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager,
    });
    session = created.session;
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      turns += 1;
      if (turns >= maxTurns && session?.isStreaming) {
        turnBudgetExhausted = true;
        void session.abort();
      }
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      void session?.abort();
    }, timeoutMs);
    const abortFromParent = () => void session?.abort();
    ctx.signal?.addEventListener("abort", abortFromParent, { once: true });
    try {
      await session.prompt(initial.text, {
        images: initial.images,
        expandPromptTemplates: false,
      });
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", abortFromParent);
      unsubscribe();
    }
    const assistantMessages = session.messages.filter((message) => message.role === "assistant") as unknown as ReviewerResponse[];
    usage.push(...assistantMessages.map((message) => message.usage).filter((item) => item !== undefined));
    if (timedOut) {
      return { result: unresolvedResult(requirements, "reviewer timed out"), evidenceIndex, probeCalls, usage, reviewerModel, probeEvidence };
    }
    if (turnBudgetExhausted) {
      return { result: unresolvedResult(requirements, "reviewer turn budget exhausted"), evidenceIndex, probeCalls, usage, reviewerModel, probeEvidence };
    }
    const response = assistantMessages.at(-1);
    if (!response || response.stopReason !== "stop") {
      return { result: unresolvedResult(requirements, `reviewer stopped before a complete verdict (${response?.stopReason ?? "unknown"})`), evidenceIndex, probeCalls, usage, reviewerModel, probeEvidence };
    }
    const parsed = finalJsonFromResponse(response);
    if (!parsed) {
      return { result: unresolvedResult(requirements, "reviewer returned malformed JSON"), evidenceIndex, probeCalls, usage, reviewerModel, probeEvidence };
    }
    const invalid = validateFinalReviewResult(parsed, requirements, knownEvidenceRefs);
    return {
      result: invalid ? unresolvedResult(requirements, `invalid reviewer output: ${invalid}`) : parsed,
      evidenceIndex,
      probeCalls,
      usage,
      reviewerModel,
      probeEvidence,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: unresolvedResult(requirements, `reviewer failed safely: ${message}`), evidenceIndex, probeCalls, usage, reviewerModel, probeEvidence };
  } finally {
    session?.dispose();
  }
}

export async function runFreshRequirementsReviewer(
  ctx: ExtensionContext,
  state: CadRunState,
  requirements: CadRequirements,
): Promise<RequirementsReviewRunOutput> {
  const model = resolveReviewerModel(ctx);
  const reviewerModel = modelLabel(model);
  const sourceMessages = requirementsSourceMessages(ctx);
  const sourceRefs = [
    ...sourceMessages.map((item) => item.ref),
    ...requirements.assertions.map((item) => `requirements:${item.id}`),
  ];
  if (!model) {
    return {
      result: unresolvedResult(requirements, "reviewer model is unavailable"),
      usage: [],
      reviewerModel,
      sourceRefs,
    };
  }
  const systemPrompt = await readFile(
    fileURLToPath(new URL("../../prompts/requirements_verifier.md", import.meta.url)),
    "utf-8",
  );
  const initial = [
    "# Selected route",
    JSON.stringify(state.route),
    "# Author-proposed requirements contract",
    JSON.stringify(requirements, null, 2),
    "# Original user conversation excerpts",
    ...(sourceMessages.length
      ? sourceMessages.flatMap((item) => [`## ${item.ref}`, item.text])
      : ["(not available; review the proposed contract for internal semantic defects)"]),
    "# Required output",
    "Return only one FinalReviewResult JSON object. Cover every proposed Assertion exactly once.",
    "For an assertion check, cite requirements:<assertionId>. For an omission or misreading, cite the relevant user:<n> excerpt when available.",
  ].join("\n\n");
  const knownEvidenceRefs = new Set(sourceRefs);
  const maxTurns = envInt("PI_CAD_REVIEWER_MAX_TURNS", 16);
  const timeoutMs = envInt("PI_CAD_REVIEWER_TIMEOUT_MS", 120_000);
  const usage: unknown[] = [];
  let timedOut = false;
  let turnBudgetExhausted = false;
  let turns = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model: model as never,
      thinkingLevel: (reviewerReasoning() ?? "off") as never,
      tools: [],
      customTools: [],
      resourceLoader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager,
    });
    session = created.session;
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      turns += 1;
      if (turns >= maxTurns && session?.isStreaming) {
        turnBudgetExhausted = true;
        void session.abort();
      }
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      void session?.abort();
    }, timeoutMs);
    const abortFromParent = () => void session?.abort();
    ctx.signal?.addEventListener("abort", abortFromParent, { once: true });
    try {
      await session.prompt(initial, { expandPromptTemplates: false });
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", abortFromParent);
      unsubscribe();
    }
    const assistantMessages = session.messages.filter((message) => message.role === "assistant") as unknown as ReviewerResponse[];
    usage.push(...assistantMessages.map((message) => message.usage).filter((item) => item !== undefined));
    const failure = timedOut
      ? "requirements reviewer timed out"
      : turnBudgetExhausted
        ? "requirements reviewer turn budget exhausted"
        : null;
    if (failure) return { result: unresolvedResult(requirements, failure), usage, reviewerModel, sourceRefs };
    const response = assistantMessages.at(-1);
    if (!response || response.stopReason !== "stop") {
      return {
        result: unresolvedResult(requirements, `requirements reviewer stopped before a complete verdict (${response?.stopReason ?? "unknown"})`),
        usage,
        reviewerModel,
        sourceRefs,
      };
    }
    const parsed = finalJsonFromResponse(response);
    if (!parsed) return { result: unresolvedResult(requirements, "requirements reviewer returned malformed JSON"), usage, reviewerModel, sourceRefs };
    const invalid = validateFinalReviewResult(parsed, requirements, knownEvidenceRefs);
    return {
      result: invalid ? unresolvedResult(requirements, `invalid requirements reviewer output: ${invalid}`) : parsed,
      usage,
      reviewerModel,
      sourceRefs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: unresolvedResult(requirements, `requirements reviewer failed safely: ${message}`), usage, reviewerModel, sourceRefs };
  } finally {
    session?.dispose();
  }
}

export const freshReviewerRunner: ReviewerRunner = { run: runFreshReviewer };
export const freshRequirementsReviewerRunner: RequirementsReviewerRunner = { run: runFreshRequirementsReviewer };
