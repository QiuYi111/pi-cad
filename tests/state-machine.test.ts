import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  acceptCandidate,
  commitPlan as commitPlanRaw,
  commitRequirements,
  createIntakeState,
  finish as finishQuick,
  markEvidenceStale,
  route as routeQuick,
  transition as transitionQuick,
} from "../src/core/state-machine.ts";

function commitPlanIfAbsent(state: ReturnType<typeof createIntakeState>) {
  const plan = commitPlanRaw(state, {
    summary: "plate plan",
    protected: [],
    plannedChanges: [],
    interfaces: [],
    datums: [],
    reviewPlan: [],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("unreachable");
  return plan.state;
}
import { recordToolEvidence } from "../src/core/evidence.ts";
import { ProjectStateStore } from "../src/shared/store.ts";
import { CAD_STATE_SCHEMA_VERSION, type CadRequirements, type Route } from "../src/shared/protocol.ts";

// The 0.7 "quick plate" maps onto the fast path: greenfield part at
// prototype maturity — but the compiled process still runs
// requirements -> part_design -> build -> review.
const quickPlateRoute: Route = {
  objective: "design",
  lineage: "greenfield",
  structure: "part",
  maturity: "prototype",
};

const record: CadRequirements = {
  goal: "100 x 80 x 5 mm plate with four 6 mm through holes, centers 10 mm from edges.",
  deliverables: ["STEP", "source"],
  must: ["100 x 80 x 5 mm", "four 6 mm through holes", "hole centers 10 mm from edges"],
  preferences: [],
  assumptions: ["sharp edges acceptable"],
  openUnknowns: [],
};

function stateInPhase(phase: "requirements" | "build" | "review" | "ready") {
  const routed = routeQuick(null, quickPlateRoute, "fully specified plate");
  assert.equal(routed.ok, true);
  if (!routed.ok) throw new Error("unreachable");
  let state = routed.state;
  if (phase === "requirements") return state;
  const req = commitRequirements(state, record);
  assert.equal(req.ok, true);
  if (!req.ok) throw new Error("unreachable");
  state = req.state;
  assert.equal(state.phase, "part_design");
  const plan = commitPlanIfAbsent(state);
  state = plan;
  if (phase === "build") return state;
  const candidate = acceptCandidate(
    state,
    {
      label: "candidate-v1",
      sources: ["models/plate.py"],
      sourceHashes: { "models/plate.py": "source-hash" },
      sourcePath: "models/plate.py",
      artifactPath: "build/plate.step",
    },
    "artifact-hash",
  );
  assert.equal(candidate.ok, true);
  if (!candidate.ok) throw new Error("unreachable");
  state = candidate.state;
  if (phase === "review") return state;
  // Add procedural evidence for accepted transition.
  state.evidence = [
    {
      id: "visual-1",
      kind: "visual",
      tool: "cad_inspect_visual",
      artifactHash: "artifact-hash",
      paths: ["evidence/iso.png"],
      createdAt: new Date().toISOString(),
    },
    {
      id: "geometry-1",
      kind: "geometry",
      tool: "cad_inspect_geometry",
      artifactHash: "artifact-hash",
      paths: ["evidence/geometry.json"],
      createdAt: new Date().toISOString(),
    },
  ];
  const accepted = transitionQuick(state, "accepted", "reviewed all seven views");
  assert.equal(accepted.ok, true);
  if (!accepted.ok) throw new Error("unreachable");
  return accepted.state;
}

test("cad_route creates intake -> requirements and rejects invalid routes", () => {
  const result = routeQuick(null, quickPlateRoute, "fully specified part");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.schemaVersion, CAD_STATE_SCHEMA_VERSION);
    assert.equal(result.state.phase, "requirements");
    assert.equal(result.state.mutationPolicy, "read_only");
    assert.deepEqual(result.state.route, quickPlateRoute);
  }
  // Fail closed: design without the full tuple.
  const badTuple = routeQuick(null, { objective: "design" } as never, "incomplete");
  assert.equal(badTuple.ok, false);
  // Fail closed: analyze carrying design keys.
  const polluted = routeQuick(null, { objective: "analyze", maturity: "release" } as never, "polluted");
  assert.equal(polluted.ok, false);
});

test("commit requirements requires requirements phase and moves through part_design to source_only build", () => {
  const state = stateInPhase("requirements");
  const result = commitRequirements(state, record);
  assert.equal(result.ok, true);
  if (result.ok) {
    // Fast path: greenfield part enters part_design (cognitive), not build.
    assert.equal(result.state.phase, "part_design");
    assert.equal(result.state.mutationPolicy, "read_only");
    assert.ok(result.state.requirementsVersion);
  }
  const bad = commitRequirements(createIntakeState(), record);
  assert.equal(bad.ok, false);
});

test("review -> accepted requires current visual and geometry evidence", () => {
  const review = stateInPhase("review");
  const blocked = transitionQuick(review, "accepted", "no evidence yet");
  assert.equal(blocked.ok, false);

  const withEvidence = {
    ...review,
    evidence: [
      {
        id: "visual-1",
        kind: "visual" as const,
        tool: "cad_inspect_visual",
        artifactHash: "artifact-hash",
        paths: ["evidence/iso.png"],
        createdAt: new Date().toISOString(),
      },
      {
        id: "geometry-1",
        kind: "geometry" as const,
        tool: "cad_inspect_geometry",
        artifactHash: "artifact-hash",
        paths: ["evidence/geometry.json"],
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const accepted = transitionQuick(withEvidence, "accepted", "reviewed");
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.state.phase, "ready");
    assert.equal(accepted.state.status, "ready");
  }
});

test("revise sends review back to source_only build", () => {
  const result = transitionQuick(stateInPhase("review"), "revise", "hole is misplaced");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.phase, "build");
    assert.equal(result.state.mutationPolicy, "source_only");
  }
});

test("finish only succeeds from ready and marks done", () => {
  const before = finishQuick(stateInPhase("review"));
  assert.equal(before.ok, false);
  const ready = stateInPhase("ready");
  const result = finishQuick(ready);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.phase, "done");
    assert.equal(result.state.status, "done");
  }
});

test("markEvidenceStale moves evidence to staleEvidence", () => {
  const state = createIntakeState();
  state.evidence = [
    {
      id: "e1",
      kind: "visual",
      tool: "cad_inspect_visual",
      artifactHash: "old",
      paths: [],
      createdAt: new Date().toISOString(),
    },
  ];
  const next = markEvidenceStale(state);
  assert.equal(next.evidence.length, 0);
  assert.equal(next.staleEvidence.length, 1);
});

test("ProjectStateStore persists and reloads state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cad-store-"));
  try {
    const store = new ProjectStateStore(dir);
    const run = await store.createRun({ runId: "test-run" });
    const state = createIntakeState({ runId: "test-run" });
    await run.save(state);
    await store.appendEvent("CadStarted", { runId: state.runId });
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded?.runId, state.runId);
    assert.equal(loaded?.phase, "intake");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeQuick only from null or intake", () => {
  const routed = stateInPhase("requirements");
  const again = routeQuick(routed, quickPlateRoute, "re-route");
  assert.equal(again.ok, false);
});

test("simulation load cases coexist by specHash instead of overwriting", () => {
  const envelopeA = {
    tool: "cad_simulate",
    artifacts: [{ path: "evidence/simulation/a/result.json", kind: "simulation", sha256: "a" }],
  };
  const envelopeB = {
    tool: "cad_simulate",
    artifacts: [{ path: "evidence/simulation/b/result.json", kind: "simulation", sha256: "b" }],
  };
  const artifactHash = "artifact-hash";
  let state = createIntakeState({ runId: "load-cases" });
  state = recordToolEvidence(state, envelopeA as any, "simulation", artifactHash, "spec-hash-a");
  state = recordToolEvidence(state, envelopeB as any, "simulation", artifactHash, "spec-hash-b");
  // Both load cases live side by side for the same artifact.
  assert.equal(state.evidence.filter((ref) => ref.kind === "simulation").length, 2);
  assert.deepEqual(
    state.evidence.filter((ref) => ref.kind === "simulation").map((ref) => ref.specHash).sort(),
    ["spec-hash-a", "spec-hash-b"],
  );
  // Re-running load case A replaces only A; B survives untouched.
  const rerunA = {
    tool: "cad_simulate",
    artifacts: [{ path: "evidence/simulation/a2/result.json", kind: "simulation", sha256: "a2" }],
  };
  state = recordToolEvidence(state, rerunA as any, "simulation", artifactHash, "spec-hash-a");
  const sims = state.evidence.filter((ref) => ref.kind === "simulation");
  assert.equal(sims.length, 2);
  assert.ok(sims.some((ref) => ref.specHash === "spec-hash-a" && ref.paths[0].includes("a2")));
  assert.ok(sims.some((ref) => ref.specHash === "spec-hash-b" && ref.paths[0].includes("/b/")));

  // Evidence without a spec identity stays latest-wins per kind + artifact.
  const visual1 = { tool: "cad_inspect_visual", artifacts: [{ path: "v1.png", kind: "visual", sha256: "v1" }] };
  const visual2 = { tool: "cad_inspect_visual", artifacts: [{ path: "v2.png", kind: "visual", sha256: "v2" }] };
  state = recordToolEvidence(state, visual1 as any, "visual", artifactHash);
  state = recordToolEvidence(state, visual2 as any, "visual", artifactHash);
  const visuals = state.evidence.filter((ref) => ref.kind === "visual");
  assert.equal(visuals.length, 1);
  assert.equal(visuals[0].paths[0], "v2.png");

  // A stale candidate still invalidates every load case at once.
  const staled = markEvidenceStale(state);
  assert.equal(staled.evidence.length, 0);
  assert.equal(staled.staleEvidence.length, 3);
});
