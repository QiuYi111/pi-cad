import type { Arbitrary } from "fast-check";

import type { ReifySession, ReifySnapshot } from "./session.ts";
import type { ReifyTrace } from "./trace.ts";

export type Params = Record<string, unknown>;

export interface ReifyContext {
  session: ReifySession;
  trace: ReifyTrace;
  params: Params;
}

export interface ReifyInvariantContext {
  session: ReifySession;
  snapshot: ReifySnapshot;
  now: number;
}

/**
 * The explicit result of one fault step.
 *
 * A fault is never "quietly skipped" just because something threw. The only
 * way a fault becomes `NotApplicable` is a deliberate real-state decision
 * (`precondition()` says so, or `inject()` raises `FaultNotApplicable`).
 * Every other error out of `inject` is a real failure and is reported as
 * `InjectionFailed`, never folded into "this fault did not apply".
 */
export type FaultStatus = "NotApplicable" | "Injected" | "InjectionFailed" | "Recovered" | "RecoveryFailed";

export interface FaultOutcome {
  name: string;
  /** Which side of the fault produced this outcome. */
  phase: "inject" | "recover";
  status: FaultStatus;
  at: number;
  /** Why it did not apply, or what really failed. */
  reason?: string;
  evidence?: unknown;
}

/**
 * Raised by a fault that deliberately decided its precondition is gone
 * (for example the run went terminal between the check and the injection).
 * Only this typed signal counts as NotApplicable.
 */
export class FaultNotApplicable extends Error {
  constructor(
    readonly reason: string,
    readonly evidence: unknown = undefined,
  ) {
    super(reason);
    this.name = "FaultNotApplicable";
  }
}

export interface FaultPrecondition {
  applicable: boolean;
  reason?: string;
  evidence?: unknown;
}

/** One real user/system step against the running Reify instance. */
export interface ReifyActionDefinition {
  name: string;
  description: string;
  arbitrary: Arbitrary<Params>;
  describe(params: Params): string;
  run(ctx: ReifyContext): Promise<void>;
}

/** A real fault: inject breaks a real process, recover proves/does recovery. */
export interface ReifyFaultDefinition {
  name: string;
  description: string;
  arbitrary: Arbitrary<Params>;
  describe(params: Params): string;
  /**
   * Real-state check that runs before `inject`. Returning
   * `{ applicable: false }` is the honest way to say "nothing to hit here";
   * anything thrown out of `inject` afterwards is a failure, not a skip.
   */
  precondition?(ctx: ReifyContext): Promise<FaultPrecondition>;
  inject(ctx: ReifyContext): Promise<void>;
  recover(ctx: ReifyContext): Promise<void>;
}

export interface ReifyInvariantDefinition {
  name: string;
  description: string;
  check(ctx: ReifyInvariantContext): Promise<void>;
}
