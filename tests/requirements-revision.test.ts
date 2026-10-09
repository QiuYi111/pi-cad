import assert from "node:assert/strict";
import { test } from "node:test";

import type { CadRequirements } from "../src/shared/protocol.ts";
import { hashRecord } from "../src/shared/hash.ts";

function requirements(overrides: Partial<CadRequirements> = {}): CadRequirements {
  return {
    goal: "make a bracket",
    deliverables: ["STEP", "report"],
    must: [],
    assertions: [],
    preferences: ["light", "simple"],
    assumptions: ["metric", "bare"],
    openUnknowns: ["finish"],
    inputs: [],
    evidenceObligations: {
      simulation: {
        disposition: "required",
        cases: [{ id: "load-a", tool: "cad_simulate" }],
      },
    },
    deferredClarifications: [{
      question: "finish?", reason: "not specified", alternatives: ["paint", "bare"], fallback: "bare", impact: "cosmetic",
    }],
    ...overrides,
  };
}

test("canonical hashes include nested requirements, assertions, plans, interfaces and workstreams", () => {
  const base = requirements();
  assert.notEqual(hashRecord(base), hashRecord({
    ...base,
    evidenceObligations: { simulation: { disposition: "required", cases: [{ id: "load-b", tool: "cad_simulate" }] } },
  }));
  const assertion = {
    id: "A1", mustRef: "M1", statement: "x", binding: { subject: "body", quantity: "extent", direction: "X" },
    expectation: { kind: "exact", value: 10, unit: "mm" } as const,
  };
  assert.notEqual(hashRecord(assertion), hashRecord({ ...assertion, binding: { ...assertion.binding, direction: "Y" } }));
  const plan = { interfaces: [{ id: "I1", fit: { kind: "clearance", value: 0.2 } }], workstreams: [{ name: "drawing", status: "open" }] };
  assert.notEqual(hashRecord(plan), hashRecord({ ...plan, interfaces: [{ id: "I1", fit: { kind: "clearance", value: 0.3 } }] }));
  assert.notEqual(hashRecord(plan), hashRecord({ ...plan, workstreams: [{ name: "drawing", status: "complete" }] }));
});

test("canonical hashing ignores object key order and preserves array order", () => {
  assert.equal(hashRecord({ b: { y: 2, x: 1 }, a: 0 }), hashRecord({ a: 0, b: { x: 1, y: 2 } }));
  assert.notEqual(hashRecord({ values: ["a", "b"] }), hashRecord({ values: ["b", "a"] }));
});
