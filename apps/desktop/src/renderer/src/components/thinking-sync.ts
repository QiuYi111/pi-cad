import type { RuntimeStatus, ThinkingLevel } from "@shared/contracts";

/** First retry delay for a rejected reconciliation, doubling up to the cap. */
const THINKING_SYNC_RETRY_MS = 1_200;
const THINKING_SYNC_RETRY_MAX_MS = 15_000;

/** A level already handed to the runtime, and the session it was handed to. */
export interface ThinkingDelivery { sessionId?: string; level: ThinkingLevel }

/** One session that still has to be told the level it should run. */
export interface ThinkingSyncTarget { sessionId?: string; level: ThinkingLevel }

/** Identifies one reconciliation: the level one session still has to be told. */
export function thinkingRequestKey(sessionId: string | undefined, level: ThinkingLevel): string {
  return `${sessionId ?? ""}:${level}`;
}

/**
 * The level the running session still has to be told, or `undefined` when it
 * already holds the saved one.
 *
 * The runtime only takes a level while it is up, so a value folded by the
 * catalog during `starting` is delivered as soon as it is ready. A delivery
 * only counts for the session it was made in: a switch can restore a session
 * that runs a different level while the saved setting never moves, and that
 * switch has to be reconciled instead of being skipped as "already delivered".
 */
export function pendingThinkingLevel(status: RuntimeStatus, saved: ThinkingLevel, delivered?: ThinkingDelivery): ThinkingLevel | undefined {
  if (status.state !== "ready" && status.state !== "streaming") return undefined;
  // Prime reports the level the live session holds, which is authoritative even
  // when this renderer never sent one.
  if (status.thinking === saved) return undefined;
  if (delivered && delivered.sessionId === status.sessionId && delivered.level === saved) return undefined;
  return saved;
}

/**
 * Backoff for a runtime that keeps rejecting `set_thinking_level`. The first
 * retry follows the first failure closely; later ones wait longer so a runtime
 * that stays down is not hammered, while the split stays visible.
 */
export function thinkingRetryDelayMs(failures: number): number {
  const steps = Math.min(Math.max(failures, 1) - 1, 6);
  return Math.min(THINKING_SYNC_RETRY_MS * 2 ** steps, THINKING_SYNC_RETRY_MAX_MS);
}

/** Shown while the saved level and the running session sit on different levels. */
export function thinkingSyncMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Effort is not synced with the running session: ${detail}. Retrying…`;
}

/** What a settled reconciliation reports back to the component. */
export interface ThinkingSyncEvents {
  /** The runtime accepted this level for this session. */
  accepted(delivery: ThinkingDelivery): void;
  /** The RPC failed and no newer target replaced it; the split stays visible. */
  rejected(message: string): void;
  /** Wait this long, then reconcile the same target again. */
  retry(delayMs: number): void;
}

export interface ThinkingReconcilerOptions {
  /** Hands one level to the runtime; resolves once the runtime accepted it. */
  send(level: ThinkingLevel): Promise<void>;
  /** Called on the component when a reconciliation settles. */
  events: ThinkingSyncEvents;
}

/**
 * Ordering for the `set_thinking_level` reconciliations.
 *
 * Only one reconcile may be on the wire at a time. Sending a second level while
 * the first is still pending lets the older RPC land last, and a sidecar that
 * applies whichever level arrives last would then run the level nobody is
 * asking for any more. A newer target therefore waits for the request already
 * in flight; when that request settles, the newest target is what goes out, so
 * the level that lands last is always the level that was asked for last.
 *
 * The settled request that a newer target replaced is also not allowed to
 * publish anything: its level is not the target any more, so marking it
 * delivered, showing its error, or scheduling its retry would all describe a
 * session that is no longer the one being reconciled.
 *
 * The reconciler also owns the "already delivered" marker. A React effect can
 * still run against a render from before a delivery landed, so a component that
 * decided "is this level delivered?" from its own state would ask for a level
 * that was just delivered. Here the decision reads the bookkeeping that the
 * delivery itself wrote, which is always the current one.
 */
export class ThinkingReconciler {
  private inFlight?: string;
  private queued?: ThinkingSyncTarget;
  private target?: string;
  private delivered?: ThinkingDelivery;
  private failures = 0;

  constructor(private readonly options: ThinkingReconcilerOptions) {}

  /**
   * Reconcile the saved level against the level the live session reports. Does
   * nothing while the session already runs the saved level or the level was
   * already delivered to this session.
   */
  sync(status: RuntimeStatus, saved: ThinkingLevel): void {
    const level = pendingThinkingLevel(status, saved, this.delivered);
    if (!level) return;
    this.reconcile({ sessionId: status.sessionId, level });
  }

  /**
   * Ask for one session to run one level. A second target only replaces the
   * queued one; it never starts a request while another is in flight.
   */
  reconcile(target: ThinkingSyncTarget): void {
    const request = thinkingRequestKey(target.sessionId, target.level);
    if (this.inFlight) {
      // The same request is already on the wire, so there is nothing to queue.
      if (this.inFlight === request) this.queued = undefined;
      else this.queued = target;
      return;
    }
    this.start(target);
  }

  private start(target: ThinkingSyncTarget): void {
    const request = thinkingRequestKey(target.sessionId, target.level);
    if (this.target !== request) {
      this.target = request;
      this.failures = 0;
    }
    this.inFlight = request;
    this.queued = undefined;
    let sent: Promise<void>;
    try {
      sent = this.options.send(target.level);
    } catch (error) {
      sent = Promise.reject(error);
    }
    void sent.then(() => this.settle(target, request, undefined), (error: unknown) => this.settle(target, request, error));
  }

  private settle(target: ThinkingSyncTarget, request: string, error: unknown): void {
    // A newer dispatch replaced this one, so its outcome is already irrelevant.
    if (this.inFlight !== request) return;
    this.inFlight = undefined;
    const queued = this.queued;
    this.queued = undefined;
    if (queued) {
      // The target moved while this request was pending: this request is stale,
      // so its result is not published and the newest target goes out now.
      this.start(queued);
      return;
    }
    if (error === undefined) {
      this.failures = 0;
      const delivery = { sessionId: target.sessionId, level: target.level };
      this.delivered = delivery;
      this.options.events.accepted(delivery);
      return;
    }
    this.failures += 1;
    this.options.events.rejected(thinkingSyncMessage(error));
    this.options.events.retry(thinkingRetryDelayMs(this.failures));
  }
}
