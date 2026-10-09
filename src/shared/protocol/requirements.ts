/**
 * Requirements record and its acceptance assertions.
 */

import type { EvidenceObligations } from "./evidence.ts";

export interface CadRequirements {
  goal: string;
  evidenceObligations?: EvidenceObligations;
  deliverables: string[];
  must: string[];
  /**
   * Pre-registered verification intent. Assertions are committed before the
   * candidate exists and must cover every Must exactly once (M1, M2, ...).
   * They describe what to establish, never candidate-specific selectors or
   * probe programs.
   */
  assertions: AcceptanceAssertion[];
  preferences: string[];
  assumptions: string[];
  openUnknowns: string[];
  /**
   * High-impact questions that would have been asked interactively, but were
   * resolved with an explicit fallback so a headless run could continue.
   */
  deferredClarifications?: Array<{
    question: string;
    reason: string;
    alternatives: string[];
    fallback: string;
    impact: string;
  }>;
  /** Artifacts supplied by the user and bound by the baseline auto-action. */
  inputs?: string[];
}

type CanonicalAssertionField =
  | "bbox.x"
  | "bbox.y"
  | "bbox.z"
  | "volume"
  | "surfaceArea"
  | "solidCount"
  | "occurrenceCount"
  | "cylinderCount";

type AssertionExpectation =
  | { kind: "exact"; value: number; unit?: string; tolerance?: number }
  | { kind: "range"; min?: number; max?: number; unit?: string }
  | { kind: "boolean"; expected: boolean }
  | { kind: "relation"; description: string };

interface AcceptanceAssertion {
  id: string;
  /** Stable 1-based reference into CadRequirements.must, e.g. M1. */
  mustRef: string;
  statement: string;
  binding: {
    subject: string;
    quantity: string;
    reference?: string;
    direction?: string;
  };
  expectation: AssertionExpectation;
  /** Opt-in only: the harness never infers this mapping from prose. */
  canonicalCheck?: { field: CanonicalAssertionField };
}
