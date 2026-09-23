import type { FaultDefinition, Params, Trace } from "../types.ts";
import type { Session } from "../sut/session.ts";

interface ActiveFault {
  definition: FaultDefinition;
  params: Params;
}

/** Tracks injected faults so `recoverAll` can undo them in reverse order. */
export class FaultRuntime {
  private readonly active = new Map<string, ActiveFault>();

  constructor(private readonly session: Session) {}

  async inject(definition: FaultDefinition, params: Params, trace: Trace): Promise<void> {
    await definition.inject({ session: this.session, trace, params });
    this.active.set(definition.name, { definition, params });
  }

  async recover(definition: FaultDefinition, trace: Trace): Promise<void> {
    const entry = this.active.get(definition.name);
    if (!entry) return;
    await definition.recover({ session: this.session, trace, params: entry.params });
    this.active.delete(definition.name);
  }

  async recoverAll(trace: Trace): Promise<void> {
    for (const name of [...this.active.keys()].reverse()) {
      const entry = this.active.get(name)!;
      try {
        await entry.definition.recover({ session: this.session, trace, params: entry.params });
      } catch (error) {
        trace.note(`fault recover failed: ${name}`, String(error));
      }
      this.active.delete(name);
    }
  }

  list(): string[] {
    return [...this.active.keys()];
  }
}
