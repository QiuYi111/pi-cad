import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Check } from "typebox/value";

import { toolsForPhase } from "../src/core/policies.ts";
import {
  acceptCandidate,
  createIntakeState,
  finish,
  route,
  commitRequirements,
  transition,
} from "../src/core/state-machine.ts";
import { recordToolEvidence } from "../src/core/evidence.ts";
import type { CadRunState, EvidenceRef } from "../src/shared/protocol.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface MockPi {
  tools: Map<string, any>;
  registerTool(tool: { name: string }): void;
  registerCommand(): void;
  on(): void;
  setActiveTools(): void;
  appendEntry(): void;
  sendUserMessage(): void;
  setSessionName(): void;
  events: { emit(): void; on(): void };
}

function mockPi(): MockPi {
  const pi: MockPi = {
    tools: new Map(),
    registerTool(tool) {
      pi.tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
    setSessionName() {},
    events: { emit() {}, on() {} },
  };
  return pi;
}

const GREENFIELD_ROUTE = {
  objective: "design",
  lineage: "greenfield",
  structure: "part",
  maturity: "prototype",
} as const;

function greenfieldReadyState(
  simulationObligation?: { disposition: "required"; cases?: Array<{ id: string; tool: string }> },
): CadRunState {
  let state = createIntakeState();
  const routed = route(state, GREENFIELD_ROUTE, "thermal-fluid walking skeleton");
  if (!routed.ok) throw new Error(routed.reason);
  state = routed.state;
  const committed = commitRequirements(state, {
    goal: "nozzle with supersonic outlet and controlled hot-section temperature",
    deliverables: ["nozzle.step"],
    must: ["outlet Mach > 1 at declared operating point"],
    assertions: [{ id: "A-mach", mustRef: "M1", statement: "Outlet Mach exceeds 1 at the declared operating point", binding: { subject: "outlet flow", quantity: "Mach number", reference: "declared operating point" }, expectation: { kind: "range", min: 1 } }],
    preferences: [],
    assumptions: [],
    openUnknowns: [],
    ...(simulationObligation
      ? { evidenceObligations: { simulation: simulationObligation } }
      : {}),
  });
  if (!committed.ok) throw new Error(committed.reason);
  state = committed.state;
  // part_design -> build (fast path: plan commit enters build)
  for (const event of ["plan_committed"]) {
    const next = transition(state, event, "test");
    if (!next.ok) throw new Error(next.reason);
    state = next.state;
  }
  const accepted = acceptCandidate(state, {
    label: "c1",
    sources: ["models/nozzle.py"],
    sourceHashes: { "models/nozzle.py": "s" },
    sourcePath: "models/nozzle.py",
    artifactPath: "build/nozzle.step",
  }, "a".repeat(64));
  if (!accepted.ok) throw new Error(accepted.reason);
  return reviewEvidence(accepted.state);
}

function simulationEvidence(
  state: CadRunState,
  tool: string,
  caseId?: string,
): CadRunState {
  const envelope = {
    ok: true,
    tool,
    toolVersion: "test",
    inputHashes: {},
    outputHashes: {},
    durationMs: 1,
    warnings: [],
    artifacts: [{ path: `.pi-cad/runs/${state.runId}/evidence/${tool}.json`, kind: "simulation", sha256: "h" }],
  };
  return recordToolEvidence(state, envelope as any, "simulation", state.currentArtifactHash!, "spec-hash", caseId);
}

function reviewEvidence(state: CadRunState): CadRunState {
  for (const kind of ["visual", "geometry"] as const) {
    const envelope = {
      ok: true,
      tool: `cad_inspect_${kind}`,
      toolVersion: "test",
      inputHashes: {},
      outputHashes: {},
      durationMs: 1,
      warnings: [],
      artifacts: [{ path: `.pi-cad/runs/${state.runId}/evidence/${kind}.png`, kind, sha256: "h" }],
    };
    state = recordToolEvidence(state, envelope as any, kind, state.currentArtifactHash!);
  }
  return state;
}

test("simulation case obligations close only with the declared tool and case id", () => {
  const cases = [
    { id: "nozzle-outlet", tool: "cad_simulate_flow" as const },
    { id: "hot-section", tool: "cad_simulate_thermal" as const },
  ];
  let state = greenfieldReadyState({ disposition: "required", cases });

  // A structural run satisfies neither declared case.
  state = simulationEvidence(state, "cad_simulate");
  let result = transition(state, "accepted", "structural only");
  assert.ok(!result.ok);
  assert.match(result.reason, /nozzle-outlet \(cad_simulate_flow\)/);

  // Closing the flow case with the wrong tool does not count.
  state = simulationEvidence(state, "cad_simulate", "nozzle-outlet");
  result = transition(state, "accepted", "wrong tool");
  assert.ok(!result.ok);
  assert.match(result.reason, /nozzle-outlet \(cad_simulate_flow\)/);

  // Closing it with the right tool + case id leaves the thermal case open.
  state = simulationEvidence(state, "cad_simulate_flow", "nozzle-outlet");
  result = transition(state, "accepted", "flow closed only");
  assert.ok(!result.ok);
  assert.match(result.reason, /hot-section \(cad_simulate_thermal\)/);

  // Both cases closed -> acceptance proceeds.
  state = simulationEvidence(state, "cad_simulate_thermal", "hot-section");
  result = transition(state, "accepted", "both cases closed");
  assert.ok(result.ok, result.reason);
  assert.equal(result.state.phase, "ready");

  // finish also enforces case closure from the ready phase.
  const finishResult = finish(result.state);
  assert.ok(finishResult.ok, (finishResult as any).reason);
});

test("simulation cases re-arm when a new candidate is committed", () => {
  const cases = [{ id: "nozzle-outlet", tool: "cad_simulate_flow" as const }];
  let state = greenfieldReadyState({ disposition: "required", cases });
  state = simulationEvidence(state, "cad_simulate_flow", "nozzle-outlet");

  // Geometry change from review: revise -> build -> new candidate.
  const revised = transition(state, "revise", "geometry change");
  assert.ok(revised.ok, revised.reason);
  const reAccepted = acceptCandidate(revised.state, {
    label: "c2",
    sources: ["models/nozzle.py"],
    sourceHashes: { "models/nozzle.py": "s2" },
    sourcePath: "models/nozzle.py",
    artifactPath: "build/nozzle.step",
  }, "b".repeat(64));
  assert.ok(reAccepted.ok, reAccepted.reason);
  const withReviewEvidence = reviewEvidence(reAccepted.state);
  const result = transition(withReviewEvidence, "accepted", "new candidate needs rerun");
  assert.ok(!result.ok);
  assert.match(result.reason, /required simulation evidence is missing|nozzle-outlet/);
});

test("two obligations sharing a case id but different tools coexist", () => {
  const cases = [
    { id: "operating-point", tool: "cad_simulate_flow" as const },
    { id: "operating-point", tool: "cad_simulate_thermal" as const },
  ];
  let state = greenfieldReadyState({ disposition: "required", cases });
  state = simulationEvidence(state, "cad_simulate_flow", "operating-point");
  // The thermal run must not evict the flow evidence despite the shared id.
  state = simulationEvidence(state, "cad_simulate_thermal", "operating-point");
  const caseEvidence = state.evidence.filter((ref: EvidenceRef) => ref.kind === "simulation" && ref.caseId === "operating-point");
  assert.equal(caseEvidence.length, 2);
  const result = transition(state, "accepted", "both closed under the shared id");
  assert.ok(result.ok, result.reason);
});

test("case-less required simulation keeps the legacy any-evidence behavior", () => {
  let state = greenfieldReadyState({ disposition: "required" });
  let result = transition(state, "accepted", "no simulation yet");
  assert.ok(!result.ok);
  assert.match(result.reason, /required simulation evidence is missing/);
  state = simulationEvidence(state, "cad_simulate");
  result = transition(state, "accepted", "structural closes legacy obligation");
  assert.ok(result.ok, result.reason);
});

const corePiHarness = async () => {
  const pi: any = {
    handlers: new Map<string, Function[]>(),
    on(event: string, handler: Function) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
    },
    activeTools: [],
    setActiveTools() {},
    getActiveTools: () => [...pi.activeTools],
    getAllTools: () => [],
    appendEntry() {},
    sendUserMessage() {},
    events: { emit() {}, on() {} },
    registerTool() {},
    registerCommand() {},
  };
  const core = (await import("../src/extensions/core/index.ts")).default;
  core(pi);
  return pi;
};

test("not_converged flow runs create no simulation evidence and cannot close a required case", async () => {
  const { CadProjectStore } = await import("../src/shared/store.ts");
  const pi = await corePiHarness();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-notconv-"));
  try {
    const store = new CadProjectStore(cwd);
    await store.migrateLegacyProject();
    await store.ensureProject();
    const run = await store.createRun({ runId: "notconv-run" });
    await run.ensureDirs();
    let state = greenfieldReadyState({ disposition: "required", cases: [{ id: "nozzle-outlet", tool: "cad_simulate_flow" }] });
    state = { ...state, runId: "notconv-run" };
    await store.save(state);

    const toolResult = pi.handlers.get("tool_result")![0] as Function;
    const envelopeFor = (status: string) => ({
      ok: true,
      tool: "cad_simulate_flow",
      toolVersion: "test",
      inputHashes: { spec: "spec-hash" },
      outputHashes: {},
      durationMs: 1,
      warnings: [],
      artifacts: [{ path: ".pi-cad/runs/notconv-run/evidence/flow.json", kind: "simulation_result", sha256: "h" }],
      payload: { status, caseId: "nozzle-outlet" },
    });

    // A completed-but-unconverged run must not record evidence.
    await toolResult(
      {
        toolName: "cad_simulate_flow",
        details: {
          envelope: envelopeFor("not_converged"),
          artifactHash: state.currentArtifactHash,
          specHash: "spec-hash",
          caseId: "nozzle-outlet",
          kind: "simulation",
        },
      },
      { cwd },
    );
    let after = await store.load();
    assert.equal(after!.evidence.filter((ref: EvidenceRef) => ref.kind === "simulation").length, 0);

    // The case therefore stays unmet and acceptance is blocked.
    const blocked = transition(after!, "accepted", "unconverged run must not close the case");
    assert.ok(!blocked.ok);
    assert.match(blocked.reason, /required simulation evidence is missing|nozzle-outlet \(cad_simulate_flow\)/);

    // A converged run records evidence and closes the case.
    await toolResult(
      {
        toolName: "cad_simulate_flow",
        details: {
          envelope: envelopeFor("solved"),
          artifactHash: state.currentArtifactHash,
          specHash: "spec-hash",
          caseId: "nozzle-outlet",
          kind: "simulation",
        },
      },
      { cwd },
    );
    after = await store.load();
    assert.equal(after!.evidence.filter((ref: EvidenceRef) => ref.kind === "simulation").length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("obligation typos fail closed instead of silently degrading the guarantee", async () => {
  const pi = mockPi();
  const core = (await import("../src/extensions/core/index.ts")).default;
  void core;
  const controller = (await import("../src/core/controller.ts")).registerControlTools;
  // registerControlTools needs pi.registerTool only.
  controller(pi as any, {
    pi: pi as any,
    persist: async () => {},
    runBaselineAuto: async () => ({ state: {} as any, images: [], warnings: [] }),
    runCandidateAuto: async () => ({ ok: true }),
    runConvertCandidateAuto: async () => ({ ok: true }),
  });
  const requirements = pi.tools.get("cad_commit_requirements");
  assert.ok(requirements, "cad_commit_requirements registered");
  const obligations = requirements.parameters.properties.evidenceObligations;

  const valid = {
    simulation: {
      disposition: "required",
      rationale: "outlet Mach is an acceptance constraint",
      cases: [{ id: "nozzle-outlet", tool: "cad_simulate_flow" }],
    },
  };
  assert.equal(Check(obligations, valid), true, "well-formed obligations must validate");

  // Each typo must be rejected rather than silently dropped: "casez" would
  // fall back to the legacy any-evidence semantics under disposition=required.
  assert.equal(Check(obligations, { simulation: { ...valid.simulation, casez: valid.simulation.cases } }), false);
  assert.equal(
    Check(obligations, { simulation: { ...valid.simulation, cases: [{ id: "x", tool: "cad_simulate_flow", toool: 1 }] } }),
    false,
  );
  assert.equal(Check(obligations, { simulation: { ...valid.simulation, extra: 1 } }), false);
  assert.equal(Check(obligations, { simulation: valid.simulation, thermal: {} }), false);
  assert.equal(
    Check(obligations, { simulation: { disposition: "required", cases: [{ id: "x", tool: "cad_simulate_flow_typo" }] } }),
    false,
  );
  assert.equal(Check(obligations, { simulation: { disposition: "required", cases: [] } }), false);
});

test("thermal/fluid tools are excluded from source phases and present where evidence is produced", () => {
  for (const phase of ["build", "modify", "convert"] as const) {
    const tools = toolsForPhase(phase);
    assert.ok(!tools.includes("cad_simulate_flow"), `${phase} must not expose cad_simulate_flow`);
    assert.ok(!tools.includes("cad_simulate_thermal"), `${phase} must not expose cad_simulate_thermal`);
    assert.ok(!tools.includes("cad_simulate"), `${phase} must not expose cad_simulate`);
  }
  for (const phase of ["review", "domain_analysis", "concept", "final_review", "ready"] as const) {
    const tools = toolsForPhase(phase);
    assert.ok(tools.includes("cad_simulate_flow"), `${phase} should expose cad_simulate_flow`);
    assert.ok(tools.includes("cad_simulate_thermal"), `${phase} should expose cad_simulate_thermal`);
  }
  // The read-only surface sensor is broadly available.
  for (const phase of ["review", "build", "domain_analysis", "ready", "baseline"] as const) {
    const tools = toolsForPhase(phase);
    if (!tools.includes("bash") && phase !== "build") continue;
    assert.ok(tools.includes("cad_inspect_surfaces"), `${phase} should expose cad_inspect_surfaces`);
  }
});

test("flow evidence re-verifies its hash-bound inputs (spec + fluidDomain) after the solve", { skip: !(await su2Available()) }, async () => {
  const { CadProjectStore } = await import("../src/shared/store.ts");
  const { verifyEvidenceFilesForHash } = await import("../src/core/evidence.ts");
  const pi = await corePiHarness();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-inputs-"));
  try {
    const { buildStep } = await import("../src/shared/capability.ts");
    await buildStep(cwd, { source: join(ROOT, "tests/fixtures/nozzle.py"), output: join(cwd, "nozzle.step"), force: true });

    const geometry = (await import("../src/extensions/geometry/index.ts")).default;
    const geometryPi = mockPi();
    geometry(geometryPi as any);
    const surfaces = geometryPi.tools.get("cad_inspect_surfaces");
    const surfaceResult = await surfaces.execute("t1", { artifact: "nozzle.step", labels: false }, undefined, undefined, { cwd });
    const facts = surfaceResult.details.envelope.payload.surfaces as Array<{ id: string; type: string; centroid: number[] }>;
    const inlet = facts.find((s) => s.type === "plane" && s.centroid[0] === 0)!.id;
    const outlet = facts.find((s) => s.type === "plane" && Math.abs(s.centroid[0] - 320) < 1e-6)!.id;
    const walls = facts.filter((s) => s.type !== "plane").map((s) => s.id);

    const simulationPi = mockPi();
    (await import("../src/extensions/simulation/index.ts")).default(simulationPi as any);
    const flow = simulationPi.tools.get("cad_simulate_flow");
    const result = await flow.execute(
      "t2",
      {
        caseId: "nozzle-outlet",
        artifact: "nozzle.step",
        fluidDomain: "nozzle.step",
        geometryUnits: "mm",
        physics: { type: "compressible_euler" },
        fluid: { model: "ideal_gas", gamma: 1.4, gasConstantJPerKgK: 287.05 },
        boundaries: [
          { type: "total_conditions_inlet", surfaces: [inlet], totalPressurePa: 420000, totalTemperatureK: 1150, flowDirection: [1, 0, 0] },
          { type: "pressure_outlet", surfaces: [outlet], staticPressurePa: 101325 },
          { type: "wall", surfaces: walls, thermal: "adiabatic" },
        ],
        initial: { mach: 0.25, temperatureK: 288.15, pressurePa: 101325 },
        mesh: { maxSizeMm: 14, minSizeMm: 5 },
        convergence: { maxIterations: 1500, residualTarget: -6 },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(result.details.envelope.payload.status, "solved");
    const roles = (result.details.envelope.inputArtifacts ?? []).map((entry: { role: string }) => entry.role).sort();
    assert.deepEqual(roles, ["artifact", "fluidDomain", "spec"]);

    // Drive the harness tool_result path so the EvidenceRef persists with
    // its inputArtifacts, then verify while inputs are still intact.
    const store = new CadProjectStore(cwd);
    await store.migrateLegacyProject();
    await store.ensureProject();
    const run = await store.createRun({ runId: "inputs-run" });
    await run.ensureDirs();
    const state = greenfieldReadyState({ disposition: "required", cases: [{ id: "nozzle-outlet", tool: "cad_simulate_flow" }] });
    await store.save({ ...state, runId: "inputs-run" });
    const toolResult = pi.handlers.get("tool_result")![0] as Function;
    await toolResult(
      {
        toolName: "cad_simulate_flow",
        details: {
          envelope: result.details.envelope,
          artifactHash: result.details.artifactHash,
          specHash: result.details.specHash,
          caseId: "nozzle-outlet",
          kind: "simulation",
        },
      },
      { cwd },
    );
    const saved = await store.load();
    const ref = saved!.evidence.find((r: EvidenceRef) => r.kind === "simulation")!;
    assert.ok(ref.inputArtifacts?.length === 3, "inputArtifacts persisted on EvidenceRef");
    // Subject (which design this is about) is distinct from consumed inputs.
    assert.equal(ref.subjectArtifactHash, ref.artifactHash);
    assert.equal(ref.artifactHash, result.details.artifactHash);
    assert.ok(ref.inputArtifacts!.every((entry) => entry.sha256 !== undefined && entry.role !== undefined));
    assert.equal(await verifyEvidenceFilesForHash(cwd, saved!, result.details.artifactHash, ["simulation"]), null);

    // The loophole: rewrite the fluid-domain STEP after the solve. Outputs
    // are untouched, but the input re-verification must now fail.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(cwd, "nozzle.step"), "\n");
    const failure = await verifyEvidenceFilesForHash(cwd, saved!, result.details.artifactHash, ["simulation"]);
    assert.ok(failure, "tampered fluid domain must fail verification");
    // artifact and fluidDomain are the same file in this fixture; either role
    // surfacing proves the input re-verification fired.
    assert.match(failure, /evidence input hash changed: (artifact|fluidDomain)/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cad_simulate_flow schema is strict and case-scoped", async () => {
  const pi = mockPi();
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  simulation(pi as any);
  const tool = pi.tools.get("cad_simulate_flow");
  assert.ok(tool, "cad_simulate_flow is registered");

  const params = tool.parameters;
  assert.equal(params.additionalProperties, false);
  for (const key of ["caseId", "fluidDomain", "physics", "fluid", "boundaries", "initial", "mesh", "convergence"]) {
    assert.ok(params.properties[key], `missing ${key}`);
  }
  assert.ok(!Object.keys(params.properties).includes("spec"));
  assert.ok(!Object.keys(params.properties).includes("outputDir"));

  const validBoundary = {
    type: "total_conditions_inlet",
    surfaces: ["surf-a91f000000"],
    totalPressurePa: 420000,
    totalTemperatureK: 1150,
    flowDirection: [1, 0, 0],
  };
  assert.equal(Check(params.properties.boundaries.items, validBoundary), true);
  assert.equal(
    Check(params.properties.boundaries.items, { ...validBoundary, totalPresurePa: 1 }),
    false,
    "typo'd pressure key must be rejected",
  );
  // Positive contract: the Euler walking-skeleton spec (no viscosity) MUST
  // validate. Regression for viscosity accidentally becoming required.
  assert.equal(Check(params, baselineFlowParams()), true, "Euler without viscosity must be valid");
  // Viscous specs declare their contract explicitly.
  assert.equal(
    Check(params, {
      ...baselineFlowParams(),
      physics: { type: "compressible_rans", turbulence: "sst" },
      fluid: {
        model: "ideal_gas",
        gamma: 1.4,
        gasConstantJPerKgK: 287.05,
        viscosity: { model: "sutherland", muRefPas: 1.716e-5, temperatureRefK: 273.15, sutherlandConstantK: 110.4 },
      },
    }),
    true,
    "RANS with declared Sutherland viscosity must be valid",
  );
  // A typo inside viscosity must fail closed.
  assert.equal(
    Check(params, {
      ...baselineFlowParams(),
      fluid: { model: "ideal_gas", gamma: 1.4, gasConstantJPerKgK: 287.05, viscosity: { model: "sutherland", muRefPas: 1.716e-5, temperatureRefK: 273.15, sutherlandContantK: 110.4 } },
    }),
    false,
    "typo'd Sutherland constant must be rejected",
  );
  assert.equal(Check(params, { turbulenceInlt: {} , ...{} , ...baselineFlowParams() }), false);
});

test("cad_simulate_thermal schema is strict", async () => {
  const pi = mockPi();
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  simulation(pi as any);
  const tool = pi.tools.get("cad_simulate_thermal");
  assert.ok(tool, "cad_simulate_thermal is registered");
  const params = tool.parameters;
  assert.equal(params.additionalProperties, false);
  assert.ok(params.properties.caseId);
  assert.equal(params.properties.material.additionalProperties, false);
  const valid = {
    caseId: "hot-section",
    artifact: "build/jet.step",
    material: { conductivityWPerMK: 16.2 },
    boundaries: [{ type: "temperature", surfaces: ["surf-1"], temperatureK: 1150 }],
    mesh: { maxSizeMm: 3 },
  };
  assert.equal(Check(params, valid), true);
  assert.equal(Check(params, { ...valid, conductivty: 1 }), false, "typo must fail closed");
});

function baselineFlowParams() {
  return {
    caseId: "nozzle-outlet",
    fluidDomain: "build/nozzle.step",
    physics: { type: "compressible_euler" },
    fluid: { model: "ideal_gas", gamma: 1.4, gasConstantJPerKgK: 287.05 },
    boundaries: [
      { type: "total_conditions_inlet", surfaces: ["surf-a"], totalPressurePa: 420000, totalTemperatureK: 1150, flowDirection: [1, 0, 0] },
      { type: "pressure_outlet", surfaces: ["surf-b"], staticPressurePa: 101325 },
      { type: "wall", surfaces: ["surf-c"], thermal: "adiabatic" },
    ],
    initial: { mach: 0.25, temperatureK: 288.15, pressurePa: 101325 },
    mesh: { maxSizeMm: 8 },
    convergence: { maxIterations: 200 },
  };
}

async function su2Available(): Promise<boolean> {
  try {
    const { currentDoctorReport } = await import("../src/shared/capability.ts");
    const report = await currentDoctorReport(ROOT, 120_000);
    return (report?.capabilities as any)?.thermalFluid?.status === "ready";
  } catch {
    return false;
  }
}

test("walking skeleton: inspect surfaces -> thermal slab with analytic heat rate (SU2)", { skip: !(await su2Available()) }, async () => {
  const pi = mockPi();
  const geometry = (await import("../src/extensions/geometry/index.ts")).default;
  geometry(pi as any);
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  simulation(pi as any);

  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-thermal-fluid-"));
  try {
    const { buildStep } = await import("../src/shared/capability.ts");
    await buildStep(cwd, { source: join(ROOT, "tests/fixtures/slab.py"), output: join(cwd, "slab.step"), force: true });
    await buildStep(cwd, { source: join(ROOT, "tests/fixtures/nozzle.py"), output: join(cwd, "nozzle.step"), force: true });

    // 1. Surface facts are selectors, never semantics.
    const surfaces = pi.tools.get("cad_inspect_surfaces");
    const surfaceResult = await surfaces.execute(
      "t1",
      { artifact: "slab.step", labels: false },
      undefined,
      undefined,
      { cwd },
    );
    const envelope = surfaceResult.details.envelope;
    assert.ok(envelope.ok, JSON.stringify(envelope.payload).slice(0, 200));
    const facts = envelope.payload.surfaces as Array<{ id: string; type: string; area: number; normal?: number[] }>;
    assert.equal(facts.length, 6);
    assert.ok(facts.every((s) => /^surf-[0-9a-f]{10}$/.test(s.id)));
    assert.equal(surfaceResult.details.kind, "surfaces");
    const text = surfaceResult.content[0].type === "text" ? surfaceResult.content[0].text : "";
    assert.match(text, /selectors, not semantics/);
    const hot = facts.find((s) => s.normal?.[2] === -1)!;
    const cold = facts.find((s) => s.normal?.[2] === 1)!;

    // 2. Thermal slab against the analytic solution q = k A dT / L.
    const thermal = pi.tools.get("cad_simulate_thermal");
    const thermalResult = await thermal.execute(
      "t2",
      {
        caseId: "slab-axial",
        artifact: "slab.step",
        geometryUnits: "mm",
        material: { conductivityWPerMK: 16.2 },
        boundaries: [
          { type: "temperature", surfaces: [hot.id], temperatureK: 1150 },
          { type: "temperature", surfaces: [cold.id], temperatureK: 300 },
        ],
        mesh: { maxSizeMm: 25 },
        convergence: { maxIterations: 3000, residualTarget: -9 },
      },
      undefined,
      undefined,
      { cwd },
    );
    const tEnvelope = thermalResult.details.envelope;
    assert.ok(tEnvelope.ok, JSON.stringify(tEnvelope.payload).slice(0, 300));
    const payload = tEnvelope.payload as any;
    assert.equal(payload.status, "solved");
    assert.equal(payload.backend, "su2");
    assert.equal(thermalResult.details.kind, "simulation");
    assert.equal(thermalResult.details.caseId, "slab-axial");
    const analytic = (16.2 * 0.01 * 850) / 0.5; // 275.4 W
    const hotRate = Math.abs(payload.boundaries[hot.id].reconstructedHeatRateW);
    const coldRate = Math.abs(payload.boundaries[cold.id].reconstructedHeatRateW);
    assert.ok(
      Math.abs(hotRate - analytic) / analytic < 0.06,
      `hot face heat rate ${hotRate} vs analytic ${analytic}`,
    );
    assert.ok(
      Math.abs(coldRate - analytic) / analytic < 0.06,
      `cold face heat rate ${coldRate} vs analytic ${analytic}`,
    );
    assert.ok(payload.temperature.minK > 295 && payload.temperature.maxK < 1155);
    assert.ok(typeof payload.energyBalance.relativeReconstructedImbalance === "number");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("walking skeleton: nozzle flow evidence with supersonic outlet (SU2)", { skip: !(await su2Available()) }, async () => {
  const pi = mockPi();
  const geometry = (await import("../src/extensions/geometry/index.ts")).default;
  geometry(pi as any);
  const simulation = (await import("../src/extensions/simulation/index.ts")).default;
  simulation(pi as any);

  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-flow-"));
  try {
    const { buildStep } = await import("../src/shared/capability.ts");
    await buildStep(cwd, { source: join(ROOT, "tests/fixtures/nozzle.py"), output: join(cwd, "nozzle.step"), force: true });

    const surfaces = pi.tools.get("cad_inspect_surfaces");
    const surfaceResult = await surfaces.execute(
      "t1",
      { artifact: "nozzle.step", labels: false },
      undefined,
      undefined,
      { cwd },
    );
    const facts = surfaceResult.details.envelope.payload.surfaces as Array<{
      id: string;
      type: string;
      area: number;
      centroid: number[];
      normal?: number[];
    }>;
    const inlet = facts.find((s) => s.type === "plane" && s.centroid[0] === 0)!;
    const outlet = facts.find((s) => s.type === "plane" && Math.abs(s.centroid[0] - 320) < 1e-6)!;
    const walls = facts.filter((s) => s.type !== "plane").map((s) => s.id);

    const flow = pi.tools.get("cad_simulate_flow");
    const result = await flow.execute(
      "t2",
      {
        caseId: "nozzle-outlet",
        fluidDomain: "nozzle.step",
        geometryUnits: "mm",
        physics: { type: "compressible_euler" },
        fluid: { model: "ideal_gas", gamma: 1.4, gasConstantJPerKgK: 287.05 },
        boundaries: [
          {
            type: "total_conditions_inlet",
            surfaces: [inlet.id],
            totalPressurePa: 420000,
            totalTemperatureK: 1150,
            flowDirection: [1, 0, 0],
          },
          { type: "pressure_outlet", surfaces: [outlet.id], staticPressurePa: 101325 },
          { type: "wall", surfaces: walls, thermal: "adiabatic" },
        ],
        initial: { mach: 0.25, temperatureK: 288.15, pressurePa: 101325 },
        mesh: { maxSizeMm: 14, minSizeMm: 5 },
        convergence: { maxIterations: 1500, residualTarget: -6 },
      },
      undefined,
      undefined,
      { cwd },
    );
    const envelope = result.details.envelope;
    assert.ok(envelope.ok, JSON.stringify(envelope.payload).slice(0, 300));
    const payload = envelope.payload as any;
    assert.equal(payload.status, "solved");
    assert.equal(payload.backend, "su2");
    assert.equal(result.details.caseId, "nozzle-outlet");
    assert.ok(payload.mesh.nodeCount > 500, "mesh must be non-trivial");
    assert.ok(payload.massBalance.relativeImbalance < 0.05, `mass imbalance ${payload.massBalance.relativeImbalance}`);
    const outletMach = payload.boundaries[outlet.id].areaWeightedMean_Mach;
    assert.ok(outletMach > 1.0, `outlet Mach ${outletMach} should be supersonic`);
    assert.ok(outletMach < 3.0, `outlet Mach ${outletMach} within the isentropic ballpark`);
    // Evidence is hash-bound and case-scoped.
    assert.equal(result.details.kind, "simulation");
    assert.ok(result.details.specHash);
    assert.ok(envelope.artifacts.length >= 3, "result, fields, and views are hash-bound");
    const adhoc = join(cwd, ".pi-cad", "adhoc", "flow");
    const dirs = await readdir(adhoc);
    assert.equal(dirs.length, 1);
    const written = JSON.parse(await readFile(join(adhoc, dirs[0], "spec.json"), "utf-8"));
    assert.equal(written.caseId, "nozzle-outlet");
    assert.equal(written.geometryUnits, "mm");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
