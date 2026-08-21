/**
 * Phase 0 golden baseline (refactor/runtime-v2).
 *
 * Pins current behavior BEFORE any refactoring phase lands:
 *
 *   1. compileWorkflow() output for every route (26 routes), with
 *      function-valued evidence resolvers pinned by probing canonical
 *      run states;
 *   2. the toolsForPhase() matrix over every phase;
 *   3. the mutationPolicyForPhase() matrix over every phase × route.
 *
 * Regenerate intentionally with:
 *
 *   UPDATE_GOLDEN=1 node tests/run-ts-tests.mjs
 *
 * Any other diff in tests/fixtures/phase0-golden.json is a behavior
 * change and must be explicitly reviewed (later phases: Phase 7 uses
 * this same file as its equivalence oracle).
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { compileWorkflow } from "../src/workflows/compiler.ts";
import {
  mutationPolicyForPhase,
} from "../src/core/state-machine.ts";
import { toolsForPhase } from "../src/core/policies.ts";
import { CAD_PHASES, type CadRunState } from "../src/shared/protocol.ts";
import { MATURITIES, routeKey, type Route } from "../src/shared/route.ts";

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "phase0-golden.json",
);

function allRoutes(): Route[] {
  const routes: Route[] = [
    { objective: "analyze" },
    { objective: "convert" },
  ];
  for (const lineage of ["greenfield", "legacy", "hybrid"] as const) {
    for (const structure of ["part", "assembly"] as const) {
      for (const maturity of MATURITIES) {
        routes.push({ objective: "design", lineage, structure, maturity });
      }
    }
  }
  return routes;
}

/**
 * Canonical probe states for evidence resolvers. They distinguish every
 * branch the resolvers actually take (baseline==current vs not, artifact
 * extension families).
 */
function evidenceProbeStates(): CadRunState[] {
  const base = {
    baselineArtifactHash: "aaaaaaaa",
    currentArtifactHash: "bbbbbbbb",
    currentArtifactPath: "models/part.py",
  };
  return [
    base,
    { ...base, baselineArtifactHash: "bbbbbbbb" },
    { ...base, baselineArtifactHash: undefined, currentArtifactPath: "out/part.step" },
    { ...base, baselineArtifactHash: undefined, currentArtifactPath: "out/part.stl" },
    { ...base, currentArtifactPath: undefined },
  ] as unknown as CadRunState[];
}

function snapshotRoute(route: Route): Record<string, unknown> {
  const spec = compileWorkflow(route);
  const probes = evidenceProbeStates();
  return {
    route: routeKey(route),
    nextAfterRequirements: spec.nextAfterRequirements,
    sourcePhases: spec.sourcePhases,
    candidateReviewPhase: spec.candidateReviewPhase,
    planNext: spec.planNext,
    planStayPhases: spec.planStayPhases,
    transitions: spec.transitions,
    acceptedPhases: spec.acceptedPhases,
    acceptedEvidence: probes.map((s) => [...spec.acceptedEvidence(s)]),
    finishEvidence: probes.map((s) => [...spec.finishEvidence(s)]),
    requiresBaselineInput: spec.requiresBaselineInput,
    baselineEvidenceRequired: spec.baselineEvidenceRequired,
    updatesHeadOnAccept: spec.updatesHeadOnAccept,
    mutationPolicies: spec.mutationPolicies ?? null,
    obligations: [...spec.obligations].sort(),
    phaseRecords: spec.phaseRecords,
  };
}

function buildGolden(): Record<string, unknown> {
  const workflowSnapshots = {};
  for (const route of allRoutes()) {
    const key = routeKey(route);
    (workflowSnapshots as Record<string, unknown>)[key] = snapshotRoute(route);
  }

  const toolMatrix: Record<string, string[]> = {};
  for (const phase of CAD_PHASES) {
    toolMatrix[phase] = [...toolsForPhase(phase)].sort();
  }

  const mutationMatrix: Record<string, Record<string, string>> = {};
  for (const route of allRoutes()) {
    const key = routeKey(route);
    const perPhase: Record<string, string> = {};
    for (const phase of CAD_PHASES) {
      perPhase[phase] = mutationPolicyForPhase(phase, route);
    }
    mutationMatrix[key] = perPhase;
  }

  return {
    version: 1,
    workflows: workflowSnapshots,
    toolsForPhase: toolMatrix,
    mutationPolicyForPhase: mutationMatrix,
  };
}

test("phase 0 golden: workflow compilation + policy matrices match the baseline", () => {
  const golden = buildGolden();
  const update = process.env.UPDATE_GOLDEN === "1";
  if (update) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`);
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(GOLDEN_PATH, "utf8");
  } catch {
    assert.fail(
      "phase0 golden file missing — generate it once with UPDATE_GOLDEN=1 and commit the result",
    );
  }
  const expected = JSON.parse(raw) as unknown;
  assert.deepEqual(
    golden,
    expected,
    "behavior drift vs phase0 golden — if intentional, regenerate with UPDATE_GOLDEN=1 and explain the diff in the PR",
  );
});
