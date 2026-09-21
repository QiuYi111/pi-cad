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
  inject(ctx: ReifyContext): Promise<void>;
  recover(ctx: ReifyContext): Promise<void>;
}

export interface ReifyInvariantDefinition {
  name: string;
  description: string;
  check(ctx: ReifyInvariantContext): Promise<void>;
}
