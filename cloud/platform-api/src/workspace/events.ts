// Per-user push channel for GET /v1/events (plan 5.3). Subscribers are plain sinks, so tests need no sockets.
export type UserEvent =
  | { type: 'workspace_state'; state: string }
  | { type: 'idle_warning'; reclaimAt: string }
  | { type: 'reclaimed' };

export type EventSink = (event: UserEvent) => void;

export class EventHub {
  private readonly sinks = new Map<string, Set<EventSink>>();

  // Returns the function that removes this subscription.
  subscribe(userId: string, sink: EventSink): () => void {
    const set = this.sinks.get(userId) ?? new Set<EventSink>();
    set.add(sink);
    this.sinks.set(userId, set);
    return () => {
      set.delete(sink);
      if (set.size === 0 && this.sinks.get(userId) === set) this.sinks.delete(userId);
    };
  }

  publish(userId: string, event: UserEvent): void {
    for (const sink of this.sinks.get(userId) ?? []) {
      try {
        sink(event);
      } catch {
        // A broken client must not stop other subscribers.
      }
    }
  }

  // The controller's notifications.
  workspaceState(userId: string, state: string): void {
    this.publish(userId, { type: 'workspace_state', state });
  }

  idleWarning(userId: string, reclaimAt: Date): void {
    this.publish(userId, { type: 'idle_warning', reclaimAt: reclaimAt.toISOString() });
  }

  reclaimed(userId: string): void {
    this.publish(userId, { type: 'reclaimed' });
  }
}
