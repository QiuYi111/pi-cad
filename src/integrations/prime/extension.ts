import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { makePhaseContractMessage, PHASE_CARD_CUSTOM_TYPE } from "./phase-card-message.ts";
import { requestAuthority, type AuthorityRequestOptions } from "./sidecar-client.ts";
import { registerExperienceTools } from "./experience-tools.ts";
import { bindingFromTranscriptEntries, WORKFLOW_BINDING_CUSTOM_TYPE, type ConversationBindingV1 } from "./workflow-binding.ts";

interface SidecarPhaseCard {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  digest: string;
  runId?: string;
  workflowHash: string;
  phase: string;
  effectiveCapabilities?: string[];
}

const REVIEW_COMPLETED_CUSTOM_TYPE = "pi-cad.review-completed";
const CONCEPT_GROUNDED_CUSTOM_TYPE = "pi-cad.concept-grounded";
const MAX_RECOVERY_TURNS = 3;

interface ReviewResult {
  verdict: string;
  target?: string;
  summary: string;
  findings: Array<{ id: string; severity: string; finding: string; evidenceRefs: string[] }>;
}

interface ReviewHandle {
  reviewId: string;
  subjectCommit: string;
  status: string;
  result?: ReviewResult;
}

interface CompletionGate {
  complete: boolean;
  reason: string;
  runId?: string;
}

/**
 * Everything one Prime conversation keeps between turns.
 *
 * A Prime process is not a conversation: the main conversation and every RLM
 * child it spawns are sessions in one process, and they take turns
 * concurrently. State that belongs to a conversation therefore lives next to
 * that conversation's session identity, never in a single module-level slot
 * that whichever session spoke last would overwrite. The durable copy of the
 * workflow binding still lives in the conversation's own transcript.
 */
interface ConversationState {
  /** The Prime session this state belongs to; null for an embedder without one. */
  sessionId: string | null;
  binding: ConversationBindingV1 | null;
  /** When this process last read this conversation's transcript for a binding. */
  readAt: string;
  reviewWatch: Promise<void> | null;
  notifiedReviews: Set<string>;
  recoveredToolCalls: Set<string>;
  groundedConceptPaths: Set<string>;
  recoveryTurns: number;
  phaseCardFailureCount: number;
  activeContractKey: string | null;
  pendingMission: string | null;
  warnedMissingSession: boolean;
}

/**
 * State per conversation, keyed by the Prime session. An embedder that cannot
 * name a session is keyed by its working directory instead of sharing one
 * process-wide slot: a host that drives two projects from one process would
 * otherwise carry one project's pending mission into the other's run.
 */
const conversationStates = new Map<string, ConversationState>();

function createConversationState(sessionId: string | null): ConversationState {
  return {
    sessionId,
    binding: null,
    readAt: new Date().toISOString(),
    reviewWatch: null,
    notifiedReviews: new Set(),
    recoveredToolCalls: new Set(),
    groundedConceptPaths: new Set(),
    recoveryTurns: 0,
    phaseCardFailureCount: 0,
    activeContractKey: null,
    pendingMission: null,
    warnedMissingSession: false,
  };
}

/**
 * The conversation on whose behalf this handler is running, found by the
 * session identity Prime gives the handler's context. Nothing here reads
 * process-wide state, so a parent and its children never borrow each other's
 * workflow identity.
 */
export function conversationStateFor(
  ctx: { cwd?: string; sessionManager?: { getSessionId(): string; getEntries(): unknown[] } } | undefined | null,
): ConversationState {
  const sessionManager = ctx?.sessionManager;
  const sessionId = typeof sessionManager?.getSessionId === "function" ? sessionManager.getSessionId() : "";
  const key = sessionId || `cwd:${ctx?.cwd ?? ""}`;
  let state = conversationStates.get(key);
  if (!state) {
    const entries = typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : [];
    state = createConversationState(sessionId);
    state.binding = bindingFromTranscriptEntries(entries, sessionId);
    if (!sessionId && !state.warnedMissingSession) {
      state.warnedMissingSession = true;
      process.stderr.write("[pi-cad] Prime session identity is unavailable; workflow requests stay project-scoped\n");
    }
    conversationStates.set(key, state);
  }
  return state;
}

/** Keep execution and learning separate while an engineering run is active. */
export function refineGateDecision(gate: CompletionGate | null): { skip: true } | undefined {
  if (!gate?.runId || gate.complete) return undefined;
  return { skip: true };
}

/** A late watcher must not wake the author for a superseded review. */
export function isCurrentReviewCompletion(completed: ReviewHandle, latest: ReviewHandle | null): boolean {
  return Boolean(
    latest
    && latest.reviewId === completed.reviewId
    && latest.subjectCommit === completed.subjectCommit
    && latest.status === completed.status
    && latest.status !== "running",
  );
}

/**
 * Recover durable notification identities from the Prime transcript. Extension
 * module state is recreated on resume, while displayed custom messages remain
 * in the session. Treat those messages as the notification ledger so an old
 * completed review cannot enqueue a second autonomous turn after restart.
 */
export function persistedReviewNotificationIds(messages: any[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message?.role !== "custom" || message.customType !== REVIEW_COMPLETED_CUSTOM_TYPE) continue;
    const detailId = message.details?.reviewId;
    if (typeof detailId === "string" && detailId) {
      ids.add(detailId);
      continue;
    }
    // Compatibility with early sessions whose displayed message did not retain
    // structured details in an imported transcript.
    const match = typeof message.content === "string"
      ? message.content.match(/Pi-CAD independent review\s+([^\s]+)\s+completed\b/)
      : null;
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}

function transcriptMessages(ctx: any): any[] {
  try {
    return (ctx.sessionManager?.getBranch?.() ?? []).map((entry: any) => entry?.message ?? entry);
  } catch {
    return [];
  }
}

function originalUserRequest(messages: any[]): string | null {
  const message = messages.find((item) => item?.role === "user");
  if (!message) return null;
  if (typeof message.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message.content)) return null;
  return message.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n")
    .trim() || null;
}

/** Append immutable phase contracts to the durable transcript; never rewrite provider history. */
export default function piCadPhaseCard(pi: ExtensionAPI): void {
  registerExperienceTools(pi);
  const ownedStateKeys = new Set<string>();
  const stateFor = (ctx: { cwd?: string; sessionManager?: { getSessionId(): string } } | undefined | null) => {
    const state = conversationStateFor(ctx);
    ownedStateKeys.add(state.sessionId || `cwd:${ctx?.cwd ?? ""}`);
    return state;
  };
  pi.on("session_shutdown", () => {
    for (const key of ownedStateKeys) conversationStates.delete(key);
    ownedStateKeys.clear();
  });

  /**
   * Every authority request names the conversation it belongs to, and states
   * what that conversation's transcript holds. `binding: null` is a real
   * declaration — the transcript was read and has no binding — so the sidecar
   * keeps the conversation unbound instead of reviving an older run from the
   * project registry. `bindingReadAt` lets the sidecar hand back only a run
   * this conversation started after that read, which is how a run started by
   * the cad Python kernel reaches the transcript.
   */
  const authorityRequest = <T>(
    state: ConversationState,
    request: Record<string, unknown>,
    options?: AuthorityRequestOptions,
  ): Promise<T> => {
    const sessionId = state.sessionId;
    return requestAuthority<T>(
      sessionId
        ? {
            ...request,
            sessionId,
            binding: state.binding,
            ...(state.binding ? {} : { bindingReadAt: state.readAt }),
          }
        : request,
      options,
    );
  };

  /**
   * Mirror the sidecar's effective binding into the conversation's own
   * transcript. A run started by cad.workflow.start() becomes durable here; an
   * unchanged binding is not rewritten.
   */
  const persistBinding = (state: ConversationState, card: SidecarPhaseCard): void => {
    if (!state.sessionId || !card.runId || !card.workflowHash) return;
    if (state.binding?.runId === card.runId && state.binding.workflowHash === card.workflowHash) return;
    const binding: ConversationBindingV1 = {
      schema: 1,
      sessionId: state.sessionId,
      runId: card.runId,
      workflowHash: card.workflowHash,
      boundAt: new Date().toISOString(),
    };
    pi.appendEntry(WORKFLOW_BINDING_CUSTOM_TYPE, binding);
    state.binding = binding;
  };

  const reviewCompletionMessage = (review: ReviewHandle) => {
    const result = review.result;
    const findings = result?.findings ?? [];
    const reviewFeedback = result ? [
      `Summary: ${result.summary}`,
      ...(findings.length ? [
        "Findings:",
        ...findings.map((finding) => {
          const evidence = finding.evidenceRefs.length ? ` Evidence: ${finding.evidenceRefs.join(", ")}` : "";
          return `- [${finding.severity.toUpperCase()}] ${finding.id}: ${finding.finding}${evidence}`;
        }),
      ] : ["Findings: none reported."]),
    ].join("\n") : "Structured review feedback is unavailable; inspect cad.review.current(handle).";
    const disposition = result?.target ? ` Workflow is already routed to ${result.target}.` : "";
    const nextAction = review.status === "unresolved"
      ? "The reviewer runtime failed; the immutable candidate was not invalidated and may be submitted again."
      : "Continue from the newly injected Phase Contract; do not guess or repeat the review transition.";
    return {
      role: "custom" as const,
      customType: REVIEW_COMPLETED_CUSTOM_TYPE,
      display: true,
      content: `Pi-CAD independent review ${review.reviewId} completed with ${review.status.toUpperCase()} for ${review.subjectCommit}.${disposition}\n${reviewFeedback}\n${nextAction}`,
      details: review,
      timestamp: Date.now(),
    };
  };
  const contractKey = (card: Pick<SidecarPhaseCard, "digest" | "workflowHash" | "phase">) =>
    `${card.workflowHash}:${card.phase}:${card.digest}`;
  const restoreContractKey = (state: ConversationState, messages: any[]) => {
    const latest = messages.filter((message) =>
      message?.role === "custom" && message.customType === PHASE_CARD_CUSTOM_TYPE && message.details?.digest
    ).at(-1);
    if (latest) state.activeContractKey = contractKey(latest.details);
  };
  const capturePendingMission = async (state: ConversationState) => {
    if (!state.pendingMission) return;
    await authorityRequest(state, { op: "mission-capture", mission: state.pendingMission });
    state.pendingMission = null;
  };
  const fallbackContractMessage = (warning: string) => ({
    customType: PHASE_CARD_CUSTOM_TYPE,
    display: false,
    content: [
      "WHERE", "- live Phase Contract request failed transiently after bounded retries", "",
      "GOAL", "- recover live canonical workflow context without guessing authority", "",
      "SOP", "- call `await cad.workflow.current()` exactly once; if it succeeds, its returned live card supersedes this fallback; if it fails, report the concrete infrastructure error", "",
      "MUST", "- re-read canonical workflow authority", "",
      "CAN", "- read only: `await cad.workflow.current()`", "",
      "NEXT", "- follow only the live card returned by `cad.workflow.current()`", "",
      "STATE", "- no stale Phase Contract was reused; workspace projections still have no authority", "",
      "WARNINGS", `- transient Phase Contract request failure: ${warning}`,
    ].join("\n"),
    details: { warning: true },
  });
  const loadContract = async (state: ConversationState) => {
    const card = await authorityRequest<SidecarPhaseCard | null>(
      state,
      { op: "phase-contract" },
      { retries: 3, retryDelayMs: 25 },
    );
    if (card) persistBinding(state, card);
    return card;
  };
  const appendChangedContract = async (state: ConversationState, deliverAs: "steer" | "followUp" = "steer") => {
    await capturePendingMission(state).catch(() => undefined);
    const card = await loadContract(state);
    if (!card) return;
    const key = contractKey(card);
    if (key === state.activeContractKey) return;
    state.activeContractKey = key;
    pi.sendMessage(makePhaseContractMessage(card), { deliverAs });
  };
  const notifyReview = async (state: ConversationState, review: ReviewHandle) => {
    if (review.status === "running" || state.notifiedReviews.has(review.reviewId)) return;
    let latest: ReviewHandle | null;
    try {
      latest = await authorityRequest<null | ReviewHandle>(state, { op: "review-current" });
    } catch {
      return;
    }
    if (!isCurrentReviewCompletion(review, latest)) {
      state.notifiedReviews.add(review.reviewId);
      return;
    }
    await appendChangedContract(state, "followUp").catch(() => undefined);
    const message = reviewCompletionMessage(review);
    pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    state.notifiedReviews.add(review.reviewId);
  };
  const watchReview = (state: ConversationState) => {
    if (state.reviewWatch) return state.reviewWatch;
    state.reviewWatch = authorityRequest<null | ReviewHandle>(state, { op: "review-watch" }, { timeoutMs: 145_000 })
      .then(async (review) => {
        if (!review) return;
        await notifyReview(state, review);
      })
      .catch(() => undefined)
      .finally(() => { state.reviewWatch = null; });
    return state.reviewWatch;
  };

  pi.on("session_before_refine", async (_event, ctx) => {
    const state = stateFor(ctx as any);
    const gate = await authorityRequest<CompletionGate>(state, { op: "completion-gate" }).catch(() => null);
    return refineGateDecision(gate);
  });

  // Print/headless Prime would otherwise exit as soon as the author says it is
  // waiting. Hold the final assistant message only for an admitted, running
  // review; the sidecar completion event then queues the sole follow-up turn.
  pi.on("message_end", async (event, ctx) => {
    const state = stateFor(ctx as any);
    if (event.message.role === "toolResult" && event.message.toolName === "codex_generate_image" && !event.message.isError) {
      const text = Array.isArray(event.message.content)
        ? event.message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n")
        : String(event.message.content || "");
      const path = text.match(/saved it to\s+(.+?\.png)(?:\.|\s|$)/i)?.[1];
      if (path) {
        try {
          const recorded = await authorityRequest<{ recorded: boolean; path: string }>(state, { op: "image-generated", path });
          if (recorded.recorded && !state.groundedConceptPaths.has(recorded.path)) {
            const project = process.env.PI_CAD_PROJECT_CWD ?? ctx.cwd;
            const bytes = await readFile(resolve(project, recorded.path));
            state.groundedConceptPaths.add(recorded.path);
            pi.sendMessage({
              role: "custom",
              customType: CONCEPT_GROUNDED_CUSTOM_TYPE,
              display: false,
              content: [
                { type: "text", text: [
                  "The generated concept image is now attached as direct visual context. Inspect the image itself before CAD.",
                  "Translate it into a geometry plan covering canonical-view silhouettes, dominant forms, continuous and separate regions, support topology, transitions and curvature, part relationships, interfaces, and visual features that must survive CAD.",
                  "The image is form and layout intent, but not dimensional authority. Do not replace its intended form with placeholder primitives.",
                ].join("\n") },
                { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
              ],
              details: { path: recorded.path },
            }, { deliverAs: "steer" });
          }
        } catch (error) {
          process.stderr.write(`[pi-cad] generated image evidence was not grounded: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
    if (
      event.message.role === "toolResult" &&
      event.message.toolName === "ipython" &&
      event.message.isError &&
      !state.recoveredToolCalls.has(event.message.toolCallId) &&
      state.recoveryTurns < MAX_RECOVERY_TURNS
    ) {
      state.recoveredToolCalls.add(event.message.toolCallId);
      state.recoveryTurns++;
      pi.sendMessage({
        customType: "pi-cad.tool-recovery",
        display: true,
        content: [
          "Pi-CAD tool call failed. This is a recovery turn, not task completion.",
          "Do not stop, summarize, or guess a transition. First run `await cad.workflow.current()` and read its `NEXT` plus canonical calls.",
          "Then repair or retry only the operation authorized by that current Phase Card and continue the original task. Stop only at a terminal workflow state or a concrete blocker.",
        ].join("\n"),
        details: { toolCallId: event.message.toolCallId, recoveryTurns: state.recoveryTurns },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return undefined;
    }
    if (event.message.role === "toolResult") {
      await appendChangedContract(state, "steer").catch((error) => {
        process.stderr.write(`[pi-cad] Phase Contract append failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
      return undefined;
    }
    if (event.message.role !== "assistant") return undefined;
    const current = await authorityRequest<null | ReviewHandle>(state, { op: "review-current" }).catch(() => null);
    if (current?.status === "running") await watchReview(state);
    return undefined;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const state = stateFor(ctx as any);
    try {
      const transcript = transcriptMessages(ctx);
      restoreContractKey(state, transcript);
      state.pendingMission ??= originalUserRequest(transcript) ?? (event.prompt.trim() || null);
      const model = ctx.model;
      if (model) {
        await authorityRequest(state, {
          op: "author-model", provider: model.provider, model: model.id, thinking: pi.getThinkingLevel(),
        }, { retries: 1, retryDelayMs: 20 }).catch(() => undefined);
      }
      await capturePendingMission(state).catch(() => undefined);
      const card = await loadContract(state);
      state.phaseCardFailureCount = 0;
      if (!card) return undefined;
      const key = contractKey(card);
      if (key === state.activeContractKey) return undefined;
      state.activeContractKey = key;
      return { message: makePhaseContractMessage(card) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const warning = reason.length > 240 ? `${reason.slice(0, 237)}...` : reason;
      state.phaseCardFailureCount++;
      process.stderr.write(`[pi-cad] Phase Contract preparation failed after retries (#${state.phaseCardFailureCount}): ${warning}\n`);
      return { message: fallbackContractMessage(warning) };
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    const state = stateFor(ctx as any);
    if (event.toolName !== "codex_generate_image") return undefined;
    try {
      const decision = await authorityRequest<null | { allowed: boolean; rendered?: string }>(state, { op: "authorize", operation: "image.generate" });
      // Imagegen remains a general Prime capability outside an active CAD run.
      if (!decision || decision.allowed) return undefined;
      return { block: true, reason: decision.rendered ?? "image.generate is not authorized by the current workflow" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `Pi-CAD authority sidecar unavailable: ${reason}` };
    }
  });

  pi.on("context", async (event, ctx) => {
    const state = stateFor(ctx as any);
    // The notification ledger is intentionally reconstructed before any watcher
    // can resolve. Otherwise resuming a completed final review races the
    // restored user prompt with a duplicate triggerTurn follow-up and can leave
    // Prime's session-action scheduler permanently "streaming" before provider I/O.
    for (const reviewId of persistedReviewNotificationIds(event.messages)) state.notifiedReviews.add(reviewId);
    restoreContractKey(state, event.messages);
    state.pendingMission ??= originalUserRequest(event.messages);
    try {
      const card = await loadContract(state);
      state.phaseCardFailureCount = 0;
      if (!card) return undefined;
      if (card.effectiveCapabilities?.includes("cad_submit_for_review")) {
        const current = await authorityRequest<null | ReviewHandle>(state, { op: "review-current" }).catch(() => null);
        if (current?.status === "running") {
          watchReview(state);
        } else if (current && !state.notifiedReviews.has(current.reviewId)) {
          // A review may have completed while Prime was offline. Feed that
          // result into the already-admitted user turn instead of creating a
          // competing triggerTurn action during resume.
          pi.sendMessage(reviewCompletionMessage(current), { deliverAs: "steer" });
          state.notifiedReviews.add(current.reviewId);
        }
      }
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const warning = reason.length > 240 ? `${reason.slice(0, 237)}...` : reason;
      state.phaseCardFailureCount++;
      // Context messages are ephemeral by design, so preserve the concrete
      // failure in stderr for headless benchmark and launcher diagnostics.
      process.stderr.write(`[pi-cad] Phase Contract observation failed after retries (#${state.phaseCardFailureCount}): ${warning}\n`);
      return undefined;
    }
  });
}
