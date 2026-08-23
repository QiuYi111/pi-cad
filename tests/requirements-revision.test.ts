import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyCadToolOverlay, toolsForState } from "../src/core/policies.ts";
import { registerControlTools } from "../src/core/controller.ts";
import { stateSummary } from "../src/core/context.ts";
import cadUiExtension from "../src/extensions/ui/index.ts";
import {
  commitRequirements,
  diffRequirements,
  earliestPhaseAfterRequirementsRevision,
  reroute as applyReroute,
  reviseRequirements,
  route,
} from "../src/core/state-machine.ts";
import type { CadRequirements, CadRunState, EvidenceRef, Route } from "../src/shared/protocol.ts";
import { CadProjectStore, hashRecord, sha256File } from "../src/shared/store.ts";

const partRoute = {
  objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype",
} as const;

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

function committed(routeValue: Route = partRoute, record = requirements()): CadRunState {
  const selected = route(null, routeValue, "test route");
  assert.equal(selected.ok, true);
  if (!selected.ok) throw new Error(selected.reason);
  const result = commitRequirements(selected.state, record);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

function evidence(id: string, kind: EvidenceRef["kind"] = "visual"): EvidenceRef {
  return {
    id, kind, tool: "test", artifactHash: "artifact-v1", paths: [], artifacts: [], createdAt: "2026-01-01T00:00:00Z",
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

test("requirements diff exposes every order-sensitive sequence and can never be empty for a version change", () => {
  const before = requirements({ must: ["first", "second"] });
  const after = requirements({
    must: ["second", "first"],
    deliverables: ["report", "STEP", "drawing"],
    inputs: ["b.step", "a.step"],
  });
  const diff = diffRequirements(before, after);
  assert.deepEqual(diff.arrays.must, {
    added: [], removed: [], orderChanged: true, before: ["first", "second"], after: ["second", "first"],
  });
  assert.equal(diff.arrays.deliverables?.orderChanged, true);
  assert.deepEqual(diff.arrays.inputs?.after, ["b.step", "a.step"]);
  assert.notEqual(hashRecord(before), hashRecord(after));
  assert.ok(Object.keys(diff.arrays).length + diff.assertions.added.length + diff.assertions.removed.length + diff.assertions.changed.length + diff.fields.length > 0);
});

test("real revision invalidates downstream claims but preserves design identities", () => {
  const before = requirements();
  const after = requirements({ goal: "make a revised bracket", evidenceObligations: undefined });
  const state: CadRunState = {
    ...committed(partRoute, before),
    phase: "review",
    planVersion: "plan-v1",
    currentSourcePath: "model.py",
    currentSourceHash: "source-v1",
    currentArtifactPath: "build/model.step",
    currentArtifactHash: "artifact-v1",
    baselineArtifactPath: "input.step",
    baselineArtifactHash: "baseline-v1",
    candidateLabel: "candidate-v1",
    evidence: [evidence("visual-1"), evidence("visual-1"), evidence("geometry-1", "geometry")],
    staleEvidence: [evidence("visual-1")],
    phaseRecords: ["assembly_design", "interface_contracts", "frame_context"],
    activeWorkstreams: ["drawing"],
    workstreamStatuses: { drawing: "complete" },
  };
  const result = reviseRequirements(state, before, after, {
    reason: "replacement specification",
    routeAssessment: { outcome: "unchanged", reason: "still a greenfield prototype part" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.state.planVersion, undefined);
  assert.deepEqual(result.state.evidence, []);
  assert.deepEqual(result.state.staleEvidence.map((item) => item.id).sort(), ["geometry-1", "visual-1"]);
  assert.deepEqual(result.state.phaseRecords, ["frame_context"]);
  assert.equal(result.state.currentArtifactHash, "artifact-v1");
  assert.equal(result.state.currentSourceHash, "source-v1");
  assert.equal(result.state.candidateLabel, "candidate-v1");
  assert.equal(result.state.phase, "part_design");
  assert.equal(result.events[0]?.type, "RequirementsRevised");

  const rebound = reviseRequirements(state, before, after, {
    reason: "replacement specification and baseline",
    routeAssessment: { outcome: "unchanged", reason: "same route" },
    baselineIdentityChanged: true,
  });
  assert.equal(rebound.ok, true);
  if (!rebound.ok) throw new Error(rebound.reason);
  assert.equal(rebound.state.phaseRecords?.includes("frame_context"), false);
});

test("same-hash recovery accepts only the exact locked unchanged predicate and keeps event history clean", () => {
  const before = requirements();
  const after = requirements({ goal: "replacement" });
  const changed = reviseRequirements(committed(partRoute, before), before, after, {
    reason: "scope changed",
    routeAssessment: { outcome: "changed", reason: "deliverable shape may require another route" },
  });
  assert.equal(changed.ok, true);
  if (!changed.ok) throw new Error(changed.reason);
  assert.equal(changed.state.routeRequiresReassessment, true);
  const projection = stateSummary(changed.state);
  assert.match(projection, /routeRequiresReassessment=true/);
  assert.match(projection, /deliverable shape may require another route/);
  assert.match(projection, /requirementsDiff=/);
  const rerouted = applyReroute(
    changed.state,
    { objective: "design", lineage: "greenfield", structure: "assembly", maturity: "prototype" },
    "the revised deliverable is an assembly",
  );
  assert.equal(rerouted.ok, true);
  if (!rerouted.ok) throw new Error(rerouted.reason);
  assert.equal(rerouted.state.routeRequiresReassessment, false);
  assert.equal(rerouted.state.phase, "assembly_design");

  const illegalChanged = reviseRequirements(changed.state, after, after, {
    reason: "retry",
    routeAssessment: { outcome: "changed", reason: "still changed" },
  });
  assert.equal(illegalChanged.ok, false);

  const recovered = reviseRequirements(changed.state, after, after, {
    reason: "correct mistaken assessment",
    routeAssessment: { outcome: "unchanged", reason: "route dimensions remain the same" },
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) throw new Error(recovered.reason);
  assert.equal(recovered.state.routeRequiresReassessment, false);
  assert.deepEqual(recovered.events.map((event) => event.type), ["RouteReassessmentConfirmed"]);
  assert.equal(recovered.state.lastRequirementsRevision?.routeAssessmentReason, "route dimensions remain the same");

  const unlockedRetry = reviseRequirements(recovered.state, after, after, {
    reason: "duplicate",
    routeAssessment: { outcome: "unchanged", reason: "same" },
  });
  assert.equal(unlockedRetry.ok, false);
});

test("compiled revision recovery uses baseline, records and plan priority", () => {
  assert.equal(earliestPhaseAfterRequirementsRevision(committed(partRoute)), "part_design");
  assert.equal(earliestPhaseAfterRequirementsRevision(committed({ objective: "design", lineage: "legacy", structure: "part", maturity: "prototype" })), "baseline");
  assert.equal(earliestPhaseAfterRequirementsRevision(committed({ objective: "design", lineage: "greenfield", structure: "assembly", maturity: "prototype" })), "assembly_design");
  assert.equal(earliestPhaseAfterRequirementsRevision(committed({ objective: "convert" })), "source_baseline");
});

test("route reassessment state policy is an exclusive hard gate and overlay uses it", () => {
  const state = { ...committed(), routeRequiresReassessment: true, interactionMode: "headless" as const };
  assert.deepEqual(toolsForState(state), [
    "read", "grep", "find", "ls", "cad_revise_requirements", "cad_reroute", "cad_declare_blocker",
  ]);
  let active = ["read", "bash", "write", "cad_transition", "cad_reroute", "third_party_mutate"];
  const all = active.map((name) => ({ name }));
  applyCadToolOverlay({
    getActiveTools: () => active,
    getAllTools: () => all,
    setActiveTools: (next: string[]) => { active = next; },
  } as never, state);
  assert.deepEqual(active.sort(), ["cad_reroute", "read"].sort());
});

test("status projections include the route reassessment reason", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-revision-status-"));
  try {
    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "run-001" });
    const before = requirements();
    const after = requirements({ goal: "assembly replacement" });
    const revised = reviseRequirements({ ...committed(partRoute, before), runId: "run-001" }, before, after, {
      reason: "replacement task",
      routeAssessment: { outcome: "changed", reason: "V2 defines a multi-part assembly" },
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) throw new Error(revised.reason);
    await store.save(revised.state);

    const eventHandlers = new Map<string, Function>();
    const commands = new Map<string, any>();
    let sessionName = "";
    cadUiExtension({
      events: { on(name: string, handler: Function) { eventHandlers.set(name, handler); } },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      setSessionName(name: string) { sessionName = name; },
    } as any);
    eventHandlers.get("pi-cad:state-changed")!(revised.state);
    assert.match(sessionName, /lock=V2 defines a multi-part assembly/);

    let widget: string[] = [];
    await commands.get("cad-status").handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      ui: { setWidget(_name: string, lines: string[]) { widget = lines; }, notify() {} },
    });
    assert.ok(widget.includes("routeRequiresReassessment=true"));
    assert.ok(widget.includes("routeReassessmentReason=V2 defines a multi-part assembly"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("journal transcript orders authoritative revision before reroute", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-revision-transcript-"));
  try {
    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "run-001" });
    const before = requirements();
    const state = { ...committed(partRoute, before), runId: "run-001", projectId: store.projectId };
    await store.writeRecord("requirements", before);
    await store.save(state);
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: any) { tools.set(tool.name, tool); } } as any;
    const persist = async (_pi: unknown, target: CadProjectStore, next: CadRunState, events: Array<{ type: string; data?: unknown }>) => {
      await target.save(next);
      for (const event of events) await target.appendEvent(event.type, event.data);
    };
    registerControlTools(pi, {
      pi,
      persist,
      runBaselineAuto: async () => { throw new Error("unused"); },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
    });
    const after = requirements({ goal: "multi-part assembly" });
    await tools.get("cad_revise_requirements").execute("t1", {
      ...after,
      reason: "authoritative scope now requires an assembly",
      routeAssessment: { outcome: "changed", reason: "part route no longer represents the deliverable" },
    }, undefined, undefined, { cwd });
    await tools.get("cad_reroute").execute("t2", {
      objective: "design", lineage: "greenfield", structure: "assembly", maturity: "prototype",
      reason: "apply the revised assembly route",
    }, undefined, undefined, { cwd });
    const journal = readFileSync(store.run("run-001").eventsPath, "utf-8");
    assert.ok(journal.indexOf('"type":"RequirementsRevised"') >= 0);
    assert.ok(journal.indexOf('"type":"RequirementsRevised"') < journal.indexOf('"type":"RouteRerouted"'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("immutable requirements records verify identity and journal repair is idempotent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-revision-store-"));
  try {
    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "run-001" });
    const record = requirements();
    const state = committed(partRoute, record);
    const revisedRecord = requirements({ goal: "new canonical goal" });
    const revised = reviseRequirements({ ...state, runId: "run-001", projectId: store.projectId }, record, revisedRecord, {
      reason: "new contract",
      routeAssessment: { outcome: "unchanged", reason: "same route" },
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) throw new Error(revised.reason);
    await store.writeRequirementsVersion(revised.state.requirementsVersion!, revisedRecord);
    await store.save(revised.state);
    assert.deepEqual(await store.readRequirementsVersion(revised.state.requirementsVersion!), revisedRecord);
    await store.appendEvent("RequirementsRevised", {
      previousVersion: "an-earlier-version",
      currentVersion: revised.state.requirementsVersion,
      at: "2025-01-01T00:00:00.000Z",
    });
    assert.equal(await store.repairRequirementsRevisionJournal(revised.state), true);
    assert.equal(await store.repairRequirementsRevisionJournal(revised.state), false);
    const events = readFileSync(store.run("run-001").eventsPath, "utf-8");
    assert.equal((events.match(/RequirementsRevisionJournalRecovered/g) ?? []).length, 1);

    writeFileSync(store.run("run-001").requirementsVersionPath(revised.state.requirementsVersion!), JSON.stringify(record));
    await assert.rejects(() => store.readRequirementsVersion(revised.state.requirementsVersion!), /hash mismatch/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a legal revision with an unavailable baseline becomes canonical before blocking; escaping inputs do not mutate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-revision-baseline-"));
  try {
    const store = new CadProjectStore(cwd);
    await store.createRun({ runId: "run-001" });
    const legacyRoute = { objective: "design", lineage: "legacy", structure: "part", maturity: "prototype" } as const;
    const before = requirements({ inputs: ["baseline.step"] });
    writeFileSync(join(cwd, "baseline.step"), "same baseline bytes");
    const state = {
      ...committed(legacyRoute, before), runId: "run-001", projectId: store.projectId, phase: "review" as const,
      baselineArtifactPath: "baseline.step", baselineArtifactHash: await sha256File(join(cwd, "baseline.step")),
      phaseRecords: ["frame_context"],
    };
    await store.writeRequirementsVersion(state.requirementsVersion!, before);
    await store.writeRecord("requirements", before);
    await store.save(state);

    const tools = new Map<string, any>();
    const pi = { registerTool(tool: any) { tools.set(tool.name, tool); } } as any;
    let baselineCalls = 0;
    const persist = async (_pi: unknown, target: CadProjectStore, next: CadRunState, events: Array<{ type: string; data?: unknown }>) => {
      await target.save(next);
      for (const event of events) await target.appendEvent(event.type, event.data);
    };
    registerControlTools(pi, {
      pi,
      persist,
      runBaselineAuto: async (_pi, _store, baselineState) => {
        baselineCalls += 1;
        return { state: baselineState, images: [], warnings: [] };
      },
      runCandidateAuto: async () => { throw new Error("unused"); },
      runConvertCandidateAuto: async () => { throw new Error("unused"); },
    });

    const changedRouteRecord = requirements({ goal: "new greenfield design", inputs: [] });
    const changedRoute = await tools.get("cad_revise_requirements").execute("changed-route", {
      ...changedRouteRecord,
      reason: "the task is now a new greenfield design",
      routeAssessment: { outcome: "changed", reason: "legacy lineage no longer applies" },
    }, undefined, undefined, { cwd });
    assert.match(changedRoute.content[0].text, /Route reassessment lock is active/);
    const locked = await store.load();
    assert.equal(locked?.status, "active");
    assert.equal(locked?.routeRequiresReassessment, true);
    assert.equal(locked?.blocker, undefined);

    // Restore the original state to exercise unchanged-route baseline rules
    // independently; the prior immutable record remains a harmless orphan.
    await store.save(state);
    const available = requirements({ goal: "canonical available V2", inputs: ["./baseline.step"] });
    const rebound = await tools.get("cad_revise_requirements").execute("r0", {
      ...available,
      reason: "the same baseline was written with an equivalent path",
      routeAssessment: { outcome: "unchanged", reason: "still a legacy prototype part" },
    }, undefined, undefined, { cwd });
    assert.match(rebound.content[0].text, /was rebound and observed/);
    assert.equal(baselineCalls, 1);
    assert.equal((await store.load())?.phase, "baseline");
    assert.equal((await store.load())?.phaseRecords?.includes("frame_context"), true);

    const next = requirements({ goal: "canonical V2", inputs: ["future.step"] });
    const response = await tools.get("cad_revise_requirements").execute("r1", {
      ...next,
      reason: "the replacement baseline has not arrived",
      routeAssessment: { outcome: "unchanged", reason: "still a legacy prototype part" },
    }, undefined, undefined, { cwd });
    assert.match(response.content[0].text, /canonical.*BLOCKED_EXTERNAL/i);
    const blocked = await store.load();
    assert.equal(blocked?.requirementsVersion, hashRecord(next));
    assert.equal(blocked?.status, "blocked_external");
    assert.equal(baselineCalls, 1, "unavailable baseline must not invoke observation");
    assert.deepEqual(await store.readRequirementsVersion(hashRecord(next)), next);

    await store.save({ ...blocked!, status: "active" });
    const escaped = requirements({ goal: "must reject", inputs: ["../outside.step"] });
    const rejected = await tools.get("cad_revise_requirements").execute("r2", {
      ...escaped,
      reason: "bad path",
      routeAssessment: { outcome: "unchanged", reason: "same route" },
    }, undefined, undefined, { cwd });
    assert.match(rejected.content[0].text, /escapes the project root/);
    assert.equal((await store.load())?.requirementsVersion, hashRecord(next));
    assert.equal(existsSync(store.run("run-001").requirementsVersionPath(hashRecord(escaped))), false);

    const invalidExtension = requirements({ goal: "must reject extension", inputs: ["baseline.txt"] });
    const extensionRejected = await tools.get("cad_revise_requirements").execute("r3", {
      ...invalidExtension,
      reason: "bad extension",
      routeAssessment: { outcome: "unchanged", reason: "same route" },
    }, undefined, undefined, { cwd });
    assert.match(extensionRejected.content[0].text, /must reference a \.step or \.stp artifact/);
    assert.equal((await store.load())?.requirementsVersion, hashRecord(next));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v5 to v6 materializes the canonical record and discards, but never applies, a pending proposal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-v5-v6-"));
  try {
    const record = requirements();
    const proposal = requirements({ goal: "unapproved proposal" });
    const version = hashRecord(record);
    const runDir = join(cwd, ".pi-cad", "runs", "run-001");
    mkdirSync(join(runDir, "records"), { recursive: true });
    writeFileSync(join(cwd, ".pi-cad", "project.json"), JSON.stringify({
      schemaVersion: 5, projectId: "project", head: { evidence: [], updatedAt: "x" }, currentRunId: "run-001", createdAt: "x", updatedAt: "x",
    }));
    writeFileSync(join(runDir, "records", "requirements.json"), JSON.stringify(record));
    writeFileSync(join(runDir, "state.json"), JSON.stringify({
      ...committed(partRoute, record), schemaVersion: 5, runId: "run-001", requirementsVersion: version,
      pendingRequirementsRevision: {
        hash: hashRecord(proposal), record: proposal, requestedAt: "2026-01-02T03:04:05.000Z",
      },
      requirementsAuthorityToken: "old", requirementsAuthorityHash: hashRecord(proposal),
      status: "blocked_user", blocker: { type: "user_authority", reason: "requirements revision approval", needed: "/cad-approve-requirements-revision", createdAt: "x" },
    }));
    const store = new CadProjectStore(cwd);
    assert.equal(await store.migrateV5ToV6(), true);
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    assert.equal(state.schemaVersion, 6);
    assert.equal(state.status, "active");
    assert.equal(state.pendingRequirementsRevision, undefined);
    assert.ok(existsSync(join(runDir, "records", "requirements", `${version}.json`)));
    assert.deepEqual(await store.run("run-001").readRequirementsVersion(version), record);
    const migrationEvents = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    assert.match(migrationEvents, new RegExp(hashRecord(proposal)));
    assert.match(migrationEvents, /2026-01-02T03:04:05\.000Z/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
