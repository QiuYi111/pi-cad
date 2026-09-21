import type { RuntimeStatus, ThinkingLevel } from "@shared/contracts";

/** First retry delay for a rejected reconciliation, doubling up to the cap. */
const THINKING_SYNC_RETRY_MS = 1_200;
const THINKING_SYNC_RETRY_MAX_MS = 15_000;

/** A level already handed to the runtime, and the session it was handed to. */
export interface ThinkingDelivery { sessionId?: string; level: ThinkingLevel }

/** One session that still has to be told the level it should run. */
export interface ThinkingSyncTarget { sessionId?: string; level: ThinkingLevel }

/** The runtime only takes a level while it is up. */
export function runtimeAcceptsThinking(status: RuntimeStatus): boolean {
  return status.state === "ready" || status.state === "streaming";
}

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
 *
 * The level Prime reports for the live session is authoritative, and it decides
 * on its own whenever it is present: a session Prime says runs another level is
 * told the saved one again even when this renderer already handed that level to
 * the same session. A marker only answers while Prime has not reported a level,
 * because then nothing else knows what the session runs.
 */
export function pendingThinkingLevel(status: RuntimeStatus, saved: ThinkingLevel, delivered?: ThinkingDelivery): ThinkingLevel | undefined {
  if (!runtimeAcceptsThinking(status)) return undefined;
  if (status.thinking !== undefined) return status.thinking === saved ? undefined : saved;
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
  /** The runtime is up and already runs the saved level, so nothing is pending. */
  consistent(): void;
  /** The runtime cannot take a level right now, so nothing is pending either. */
  unavailable(): void;
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
 *
 * The level Prime reports stays what decides. A session Prime reports on
 * another level than the saved one is told the saved level again, even when
 * this renderer handed that level to the same session before — otherwise the
 * split this reconciliation exists for would be trusted away by its own marker.
 * What the marker does answer is a render from before the delivery: Prime
 * publishes a level before the next one is handed over, so a reading the
 * renderer already held when the delivery landed belongs to the session as it
 * was before that level and cannot be a report that Prime changed its mind.
 *
 * A runtime that is down is neither a split nor a delivery. The session a
 * rejection described is gone once the runtime stops taking levels, so the
 * component is told to drop that warning and the retry behind it instead of
 * waiting for an `accepted` that can no longer come.
 */
export class ThinkingReconciler {
  private inFlight?: string;
  private queued?: { target: ThinkingSyncTarget; reading: RuntimeStatus };
  private target?: string;
  private delivered?: ThinkingDelivery;
  private readings = new WeakMap<RuntimeStatus, number>();
  private latest?: RuntimeStatus;
  private readingCount = 0;
  private latestReading = 0;
  private deliveredReading = 0;
  private failures = 0;

  constructor(private readonly options: ThinkingReconcilerOptions) {}

  /**
   * Order one runtime reading where the renderer commits it. Prime publishes a
   * level before the renderer hands over the next one, so a reading the
   * renderer already held when a delivery landed describes a session that is
   * older than the delivery — it is not a report that Prime changed its mind.
   * Only a reading that shows up after the delivery can be one. The component
   * calls this for every status it renders, before the effect that reconciles.
   */
  noteReading(status: RuntimeStatus): void {
    this.order(status);
  }

  private order(status: RuntimeStatus): number {
    const known = this.readings.get(status);
    if (known !== undefined) return known;
    this.readingCount += 1;
    this.readings.set(status, this.readingCount);
    this.latestReading = this.readingCount;
    this.latest = status;
    return this.readingCount;
  }

  /**
   * Reconcile the saved level against the level the live session reports. Does
   * nothing while the session already runs the saved level, while the level was
   * already delivered for a reading the renderer still holds, or while the
   * runtime is not up — the last one is reported, because a runtime that cannot
   * take a level has nothing left to reconcile and must not keep a warning
   * about a split that no longer exists.
   */
  sync(status: RuntimeStatus, saved: ThinkingLevel): void {
    // Every reading is ordered where the renderer commits it, including the
    // ones that cannot be reconciled: a request that settles after the runtime
    // stopped taking levels has to know that its outcome belongs to a session
    // that is gone.
    this.order(status);
    if (!runtimeAcceptsThinking(status)) {
      // The runtime cannot take a level right now: the session was stopped, the
      // sidecar went away, or it is still starting. No delivery can land and no
      // retry can fix anything, so the split an earlier rejection reported is
      // over — and so is the retry that was waiting on it. Leaving the warning
      // up would show a sync that nobody is running any more.
      this.options.events.unavailable();
      return;
    }
    // Nothing is pending once the runtime runs the saved level — either because
    // Prime says so, or because that level was delivered for a reading the
    // renderer still holds, which is too old to say the session moved since.
    const level = this.answered(status, saved) ? undefined : pendingThinkingLevel(status, saved, this.delivered);
    if (!level) {
      // Prime is up and already holds the saved level, so a split an earlier
      // rejection reported is gone; its warning must not outlive it, and
      // clearing it must not need another RPC.
      this.options.events.consistent();
      return;
    }
    this.reconcile({ sessionId: status.sessionId, level }, status);
  }

  /**
   * True when this reading cannot be newer than the last delivery: it was
   * already on screen when that level landed, so it describes the session
   * before the level was handed over. A reading that shows up afterwards is a
   * report from Prime and is always reconciled.
   */
  private answered(status: RuntimeStatus, saved: ThinkingLevel): boolean {
    const order = this.order(status);
    const delivered = this.delivered;
    if (!delivered || delivered.sessionId !== status.sessionId || delivered.level !== saved) return false;
    return order <= this.deliveredReading;
  }

  /**
   * Ask for one session to run one level. A second target only replaces the
   * queued one; it never starts a request while another is in flight.
   */
  reconcile(target: ThinkingSyncTarget, reading: RuntimeStatus): void {
    const request = thinkingRequestKey(target.sessionId, target.level);
    if (this.inFlight) {
      // The same request is already on the wire, so there is nothing to queue.
      if (this.inFlight === request) this.queued = undefined;
      else this.queued = { target, reading };
      return;
    }
    this.start(target, reading);
  }

  private start(target: ThinkingSyncTarget, reading: RuntimeStatus): void {
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
    void sent.then(
      () => this.settle(target, reading, request, undefined),
      (error: unknown) => this.settle(target, reading, request, error),
    );
  }

  private settle(target: ThinkingSyncTarget, reading: RuntimeStatus, request: string, error: unknown): void {
    // A newer dispatch replaced this one, so its outcome is already irrelevant.
    if (this.inFlight !== request) return;
    this.inFlight = undefined;
    const queued = this.queued;
    this.queued = undefined;
    if (!this.takesLevels()) {
      // The runtime stopped taking levels while this request was on the wire, so
      // whatever the request reports describes a session that is gone. A
      // rejection would put a warning back on screen with no split behind it and
      // schedule a retry that nothing can satisfy; a queued target would ask a
      // runtime that cannot take it. Both are dropped: the next reading that can
      // take a level reconciles from scratch.
      return;
    }
    if (queued) {
      // The target moved while this request was pending: this request is stale,
      // so its result is not published and the newest target goes out now.
      this.start(queued.target, queued.reading);
      return;
    }
    if (error === undefined) {
      this.failures = 0;
      const delivery = { sessionId: target.sessionId, level: target.level };
      this.delivered = delivery;
      // Every reading the renderer holds right now was published before this
      // level landed, so none of them can be a newer report about the session.
      this.deliveredReading = this.latestReading;
      this.options.events.accepted(delivery);
      return;
    }
    this.failures += 1;
    this.options.events.rejected(thinkingSyncMessage(error));
    this.options.events.retry(thinkingRetryDelayMs(this.failures));
  }

  /** True while the newest reading the renderer committed can take a level. */
  private takesLevels(): boolean {
    return this.latest === undefined || runtimeAcceptsThinking(this.latest);
  }
}
