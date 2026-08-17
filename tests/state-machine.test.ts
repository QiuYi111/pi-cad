import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  acceptCandidate,
  commitRequirements,
  createIntakeState,
  finishQuick,
  markEvidenceStale,
  routeQuick,
  transitionQuick,
} from "../src/workflows/quick.ts";
import { ProjectStateStore } from "../src/shared/store.ts";
import { CAD_STATE_SCHEMA_VERSION, type CadRequirements } from "../src/shared/protocol.ts";

const record: CadRequirements = {
  goal: "100 x 80 x 5 mm plate with four 6 mm through holes, centers 10 mm from edges.",
  deliverables: ["STEP", "source"],
  must: ["100 x 80 x 5 mm", "four 6 mm through holes", "hole centers 10 mm from edges"],
  preferences: [],
  assumptions: ["sharp edges acceptable"],
  openUnknowns: [],
  maturity: "prototype",
};

function stateInPhase(phase: "requirements" | "build" | "review" | "ready") {
  const routed = routeQuick(null, "quick", "fully specified plate");
  assert.equal(routed.ok, true);
  if (!routed.ok) throw new Error("unreachable");
  let state = routed.state;
  if (phase === "requirements") return state;
  const req = commitRequirements(state, record);
  assert.equal(req.ok, true);
  if (!req.ok) throw new Error("unreachable");
  state = req.state;
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

test("cad_route creates intake -> requirements and rejects unknown workflow", () => {
  const result = routeQuick(null, "quick", "fully specified part");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.schemaVersion, CAD_STATE_SCHEMA_VERSION);
    assert.equal(result.state.phase, "requirements");
    assert.equal(result.state.mutationPolicy, "read_only");
  }
  const bad = routeQuick(null, "greenfield", "not in V0");
  assert.equal(bad.ok, false);
});

test("commit requirements requires requirements phase and moves to source_only build", () => {
  const state = stateInPhase("requirements");
  const result = commitRequirements(state, record);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.phase, "build");
    assert.equal(result.state.mutationPolicy, "source_only");
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
    const state = createIntakeState();
    await store.save(state);
    await store.appendEvent("CadStarted", { taskId: state.taskId });
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded?.taskId, state.taskId);
    assert.equal(loaded?.phase, "intake");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeQuick only from null or intake", () => {
  const routed = stateInPhase("requirements");
  const again = routeQuick(routed, "quick", "re-route");
  assert.equal(again.ok, false);
});
