import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeEphemeralPhaseCardMessage, PHASE_CARD_CUSTOM_TYPE } from "./phase-card-message.ts";
import { requestAuthority } from "./sidecar-client.ts";
import { registerExperienceTools } from "./experience-tools.ts";

interface SidecarPhaseCard {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  digest: string;
  workflowHash: string;
  phase: string;
  effectiveCapabilities?: string[];
}

const REVIEW_COMPLETED_CUSTOM_TYPE = "pi-cad.review-completed";

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

function originalUserRequest(messages: any[]): string | null {
  const message = messages.find((item) => item?.role === "user");
  if (!message) return null;
  if (typeof message.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message.content)) return null;
  const text = message.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n").trim();
  return text || null;
}

/** The entire Prime integration: inject one current, non-persisted card per call. */
export default function piCadPhaseCard(pi: ExtensionAPI): void {
  registerExperienceTools(pi);
  let reviewWatch: Promise<void> | null = null;
  const notifiedReviews = new Set<string>();
  // Some compatible-model providers will finish a turn after an IPython error
  // without issuing the recovery call that the Phase Card requires. Queue a
  // bounded, explicit recovery turn so a failed CAD action cannot silently
  // become the end of the user's engineering task.
  const recoveredToolCalls = new Set<string>();
  let recoveryTurns = 0;
  let phaseCardFailureCount = 0;
  const MAX_RECOVERY_TURNS = 3;
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
      : "Continue from the newly injected Phase Card; do not guess or repeat the review transition.";
    return {
      role: "custom" as const,
      customType: REVIEW_COMPLETED_CUSTOM_TYPE,
      display: true,
      content: `Pi-CAD independent review ${review.reviewId} completed with ${review.status.toUpperCase()} for ${review.subjectCommit}.${disposition}\n${reviewFeedback}\n${nextAction}`,
      details: review,
      timestamp: Date.now(),
    };
  };
  const notifyReview = async (review: ReviewHandle) => {
    if (review.status === "running" || notifiedReviews.has(review.reviewId)) return;
    let latest: ReviewHandle | null;
    try {
      latest = await requestAuthority<null | ReviewHandle>({ op: "review-current" });
    } catch {
      return;
    }
    if (!isCurrentReviewCompletion(review, latest)) {
      notifiedReviews.add(review.reviewId);
      return;
    }
    const message = reviewCompletionMessage(review);
    pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    notifiedReviews.add(review.reviewId);
  };
  const watchReview = () => {
    if (reviewWatch) return reviewWatch;
    reviewWatch = requestAuthority<null | ReviewHandle>({ op: "review-watch" }, { timeoutMs: 145_000 })
      .then(async (review) => {
        if (!review) return;
        await notifyReview(review);
      })
      .catch(() => undefined)
      .finally(() => { reviewWatch = null; });
    return reviewWatch;
  };

  // Print/headless Prime would otherwise exit as soon as the author says it is
  // waiting. Hold the final assistant message only for an admitted, running
  // review; the sidecar completion event then queues the sole follow-up turn.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "toolResult" && event.message.toolName === "codex_generate_image" && !event.message.isError) {
      const text = Array.isArray(event.message.content)
        ? event.message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n")
        : String(event.message.content || "");
      const path = text.match(/saved it to\s+(.+?\.png)(?:\.|\s|$)/i)?.[1];
      if (path) await requestAuthority({ op: "image-generated", path }).catch((error) => {
        process.stderr.write(`[pi-cad] generated image evidence was not recorded: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    if (
      event.message.role === "toolResult" &&
      event.message.toolName === "ipython" &&
      event.message.isError &&
      !recoveredToolCalls.has(event.message.toolCallId) &&
      recoveryTurns < MAX_RECOVERY_TURNS
    ) {
      recoveredToolCalls.add(event.message.toolCallId);
      recoveryTurns++;
      pi.sendMessage({
        customType: "pi-cad.tool-recovery",
        display: true,
        content: [
          "Pi-CAD tool call failed. This is a recovery turn, not task completion.",
          "Do not stop, summarize, or guess a transition. First run `await cad.workflow.current()` and read its `NEXT` plus canonical calls.",
          "Then repair or retry only the operation authorized by that current Phase Card and continue the original task. Stop only at a terminal workflow state or a concrete blocker.",
        ].join("\n"),
        details: { toolCallId: event.message.toolCallId, recoveryTurns },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return undefined;
    }
    if (event.message.role !== "assistant") return undefined;
    const current = await requestAuthority<null | ReviewHandle>({ op: "review-current" }).catch(() => null);
    if (current?.status === "running") await watchReview();
    return undefined;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "codex_generate_image") return undefined;
    try {
      const decision = await requestAuthority<null | { allowed: boolean; rendered?: string }>({ op: "authorize", operation: "image.generate" });
      // Imagegen remains a general Prime capability outside an active CAD run.
      if (!decision || decision.allowed) return undefined;
      return { block: true, reason: decision.rendered ?? "image.generate is not authorized by the current workflow" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `Pi-CAD authority sidecar unavailable: ${reason}` };
    }
  });

  pi.on("context", async (event, ctx) => {
    // `notifiedReviews` is intentionally reconstructed before any watcher can
    // resolve. Otherwise resuming a completed final review races the restored
    // user prompt with a duplicate triggerTurn follow-up and can leave Prime's
    // session-action scheduler permanently "streaming" before provider I/O.
    for (const reviewId of persistedReviewNotificationIds(event.messages)) notifiedReviews.add(reviewId);
    const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === PHASE_CARD_CUSTOM_TYPE));
    try {
      const model = ctx.model;
      if (model) {
        await requestAuthority({
          op: "author-model",
          provider: model.provider,
          model: model.id,
          thinking: pi.getThinkingLevel(),
        }, { retries: 1, retryDelayMs: 20 }).catch((error) => {
          // Reviewer inheritance metadata is useful, but a transient failure
          // to report it must never suppress an otherwise valid Phase Card.
          process.stderr.write(`[pi-cad] author-model report unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
      const mission = originalUserRequest(messages);
      if (mission) await requestAuthority({ op: "mission-capture", mission }).catch(() => undefined);
      const card = await requestAuthority<SidecarPhaseCard | null>(
        { op: "phase-card" },
        { retries: 3, retryDelayMs: 25 },
      );
      phaseCardFailureCount = 0;
      if (!card) return messages.length === event.messages.length ? undefined : { messages };
      let resumedReviewMessage: ReturnType<typeof reviewCompletionMessage> | undefined;
      if (card.effectiveCapabilities?.includes("cad_submit_for_review")) {
        const current = await requestAuthority<null | ReviewHandle>({ op: "review-current" }).catch(() => null);
        if (current?.status === "running") {
          watchReview();
        } else if (current && !notifiedReviews.has(current.reviewId)) {
          // A review may have completed while Prime was offline. Feed that
          // result into the already-admitted user turn instead of creating a
          // competing triggerTurn action during resume.
          resumedReviewMessage = reviewCompletionMessage(current);
          notifiedReviews.add(current.reviewId);
        }
      }
      return {
        messages: [
          ...messages,
          ...(resumedReviewMessage ? [resumedReviewMessage] : []),
          makeEphemeralPhaseCardMessage(card),
        ],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const warning = reason.length > 240 ? `${reason.slice(0, 237)}...` : reason;
      phaseCardFailureCount++;
      // Context messages are ephemeral by design, so preserve the concrete
      // failure in stderr for headless benchmark and launcher diagnostics.
      process.stderr.write(`[pi-cad] phase-card injection failed after retries (#${phaseCardFailureCount}): ${warning}\n`);
      return {
        messages: [...messages, {
          role: "custom", customType: PHASE_CARD_CUSTOM_TYPE, display: false,
          content: [
            "WHERE", "- live Phase Card request failed transiently after bounded retries", "",
            "GOAL", "- recover live canonical workflow context without guessing authority", "",
            "SOP", "- call `await cad.workflow.current()` exactly once; if it succeeds, its returned live card supersedes this fallback; if it fails, report the concrete infrastructure error", "",
            "MUST", "- re-read canonical workflow authority", "",
            "CAN", "- read only: `await cad.workflow.current()`", "",
            "NEXT", "- follow only the live card returned by `cad.workflow.current()`", "",
            "STATE", "- no stale Phase Card was reused; workspace projections still have no authority", "",
            "WARNINGS", `- transient Phase Card injection failure: ${warning}`,
          ].join("\n"),
          details: { warning: true }, timestamp: Date.now(),
        }],
      };
    }
  });
}
