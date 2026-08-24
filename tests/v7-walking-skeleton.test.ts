import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cadRouteV7 } from "../src/domains/mechanical/actions-v7.ts";
import { commitMechanicalCandidateV7 } from "../src/domains/mechanical/candidate-actions-v7.ts";
import { commitMechanicalRecordV7, finishMechanicalRunV7, transitionMechanicalRunV7 } from "../src/domains/mechanical/control-actions-v7.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { mechanicalReviewProfile } from "../src/domains/mechanical/review-profile.ts";
import { mechanicalBuiltinWorkflows } from "../src/domains/mechanical/workflows.ts";
import { cadStart } from "../src/harness/kernel.ts";
import { runFreshReviewV7 } from "../src/harness/review.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import core from "../src/extensions/core/index.ts";
import drawing from "../src/extensions/drawing/index.ts";
import geometry from "../src/extensions/geometry/index.ts";
import presentation from "../src/extensions/presentation/index.ts";
import probe from "../src/extensions/probe/index.ts";
import simulation from "../src/extensions/simulation/index.ts";

function registerPublicActions(): void {
  const pi: any = { registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; }, appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} } };
  for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
}

test("v7 Mechanical walking skeleton atomically reaches and promotes Project Head", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v7-walking-"));
  try {
    registerPublicActions();
    await mkdir(join(cwd, "models"), { recursive: true });
    await writeFile(join(cwd, "models", "bracket.py"), "import build123d as bd\nresult = bd.Box(20, 12, 5)\n");
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "walking skeleton" });
    await cadRouteV7({ cwd, route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype" }, reason: "prototype part" });
    let loaded = await commitMechanicalRecordV7({ cwd, type: "requirements", value: { goal: "Build a bracket", deliverables: ["STEP"], must: ["solid"], assertions: [], preferences: [], assumptions: [], openUnknowns: [] } });
    assert.equal(loaded.state.phase, "part_design");
    loaded = await commitMechanicalRecordV7({ cwd, type: "plan", value: { summary: "one solid", protected: [], plannedChanges: ["build"], interfaces: [], datums: [], reviewPlan: ["visual", "geometry"] } });
    assert.equal(loaded.state.phase, "build");

    const candidate = await commitMechanicalCandidateV7({ cwd, sources: ["models/bracket.py"], label: "bracket-v1" });
    assert.equal(candidate.loaded.state.phase, "review");
    assert.deepEqual(new Set(candidate.loaded.state.evidence.map((item) => item.type)), new Set(["visual", "geometry"]));
    assert.ok(candidate.loaded.state.artifacts["candidate:authoritative"]);

    const reviewed = await runFreshReviewV7({
      cwd, workflowRunId: candidate.loaded.state.runId, registries: mechanicalRegistries,
      profile: mechanicalReviewProfile("mechanical.design-review"),
      executor: { async execute() { return { schema: 1, verdict: "pass", summary: "independent deterministic fixture review", findings: [] }; } },
    });
    assert.equal(reviewed.state.latestReview?.verdict, "pass");
    loaded = await transitionMechanicalRunV7({ cwd, event: "accepted", note: "fixture reviewer pass" });
    assert.equal(loaded.state.phase, "ready");
    await finishMechanicalRunV7({ cwd });
    const project = await new HarnessProjectStoreV7(cwd).load();
    assert.equal(project.state.currentRunId, null);
    assert.equal(project.state.promotedRunId, loaded.state.runId);
    assert.equal(project.state.head.artifacts["candidate:authoritative"]?.sha256, candidate.proposal.artifactHash);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
