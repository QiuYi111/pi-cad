import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import core from "../src/extensions/core/index.ts";
import drawing from "../src/extensions/drawing/index.ts";
import geometry from "../src/extensions/geometry/index.ts";
import presentation from "../src/extensions/presentation/index.ts";
import probe from "../src/extensions/probe/index.ts";
import simulation from "../src/extensions/simulation/index.ts";
import { MECHANICAL_ROUTES, mechanicalBuiltinWorkflows, mechanicalIntakeWorkflow, mechanicalWorkflowDefinition } from "../src/domains/mechanical/workflows.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { loadProjectWorkflowSelection, loadWorkflowSnapshot, parseYamlDocument } from "../src/harness/workflow/loader.ts";
import { cadStart } from "../src/harness/kernel.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { commitBoundEvidence, createHarnessRunState, prepareRecipeObligation, replaceWorkflowSnapshot, transitionRun } from "../src/harness/reducer.ts";
import { HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { approveMechanicalRerouteV7, cadRerouteV7, cadRouteV7 } from "../src/domains/mechanical/actions-v7.ts";
import { phaseContract } from "../src/control/phase-contract.ts";
import { routeKey } from "../src/shared/route.ts";
import { compiledSpec } from "../src/workflows/index.ts";

function registerActions(): void {
  const pi: any = {
    registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} },
  };
  for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
}

test("Mechanical adapter compiles all 26 routes into normalized equivalent snapshots", () => {
  registerActions();
  assert.equal(MECHANICAL_ROUTES.length, 26);
  const hashes = new Set<string>();
  for (const route of MECHANICAL_ROUTES) {
    const snapshot = compileWorkflowDefinition(mechanicalWorkflowDefinition(route), mechanicalRegistries);
    const legacy = compiledSpec(route);
    assert.equal(snapshot.id, `mechanical/${routeKey(route)}`);
    assert.equal(snapshot.initialPhase, "requirements");
    assert.equal(snapshot.phases.requirements.transitions.requirements_committed?.target, legacy.nextAfterRequirements);
    for (const [phase, row] of Object.entries(legacy.transitions)) {
      for (const [event, target] of Object.entries(row!)) assert.equal(snapshot.phases[phase]!.transitions[event]?.target, target);
    }
    for (const phase of Object.keys(snapshot.phases)) {
      assert.deepEqual(snapshot.phases[phase]!.grants, [...phaseContract(phase as any).grants].sort());
    }
    hashes.add(snapshot.hash);
  }
  assert.equal(hashes.size, 26);
  const intake = compileWorkflowDefinition(mechanicalIntakeWorkflow(), mechanicalRegistries);
  assert.equal(intake.initialPhase, "intake");
  assert.equal(intake.phases.intake.terminal, true);
  assert.ok(mechanicalBuiltinWorkflows().has("builtin:mechanical/intake@1"));
});

const WORKFLOW_YAML = `schema: 1
id: example/custom
version: 1.0.0
parametersSchema:
  type: object
  additionalProperties: false
initialPhase: alpha
phases:
  alpha:
    purpose: Arbitrary generic phase
    actions: [transition]
    grants: [transition]
    writeScopes: [run:state]
    recordObligations: []
    evidenceObligations: []
    contextProviders: [kernel.current-action]
    hooks: []
    transitions:
      proceed:
        target: omega
  omega:
    purpose: Terminal
    actions: [read]
    grants: [file_read]
    writeScopes: []
    recordObligations: []
    evidenceObligations: []
    contextProviders: [kernel.current-action]
    hooks: []
    transitions: {}
    terminal: true
`;

test("project YAML loads a project-confined arbitrary-phase workflow and defaults when absent", async () => {
  registerActions();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-workflow-v7-"));
  try {
    assert.equal((await loadProjectWorkflowSelection(cwd)).workflow.source, "builtin:mechanical/intake@1");
    await mkdir(join(cwd, "workflows"));
    await writeFile(join(cwd, "workflows", "custom.yaml"), WORKFLOW_YAML);
    await writeFile(join(cwd, "pi-cad.yaml"), "schema: 1\nworkflow:\n  source: workflows/custom.yaml\n  parameters: {}\n");
    const selection = await loadProjectWorkflowSelection(cwd);
    const snapshot = await loadWorkflowSnapshot({ cwd, selection, builtins: mechanicalBuiltinWorkflows(), registries: mechanicalRegistries });
    assert.deepEqual(Object.keys(snapshot.phases), ["alpha", "omega"]);
    assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
    assert.equal(compileWorkflowDefinition(parseYamlDocument(WORKFLOW_YAML, "fixture"), mechanicalRegistries).hash, snapshot.hash);

    const outside = await mkdtemp(join(tmpdir(), "pi-cad-workflow-outside-"));
    try {
      await writeFile(join(outside, "escape.yaml"), WORKFLOW_YAML);
      await symlink(join(outside, "escape.yaml"), join(cwd, "workflows", "escape.yaml"));
      await assert.rejects(
        loadWorkflowSnapshot({ cwd, selection: { schema: 1, workflow: { source: "workflows/escape.yaml", parameters: {} } }, builtins: mechanicalBuiltinWorkflows(), registries: mechanicalRegistries }),
        /escapes project root/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow compiler rejects unknown references, excessive scopes, unreachable phases, aliases, and self-granted authority", () => {
  registerActions();
  const base = parseYamlDocument(WORKFLOW_YAML, "fixture") as any;
  assert.throws(() => compileWorkflowDefinition({ ...base, phases: { ...base.phases, alpha: { ...base.phases.alpha, actions: ["not_registered"] } } }, mechanicalRegistries), /unknown actions registration/);
  assert.throws(() => compileWorkflowDefinition({ ...base, phases: { ...base.phases, alpha: { ...base.phases.alpha, writeScopes: ["project:head"] } } }, mechanicalRegistries), /exceeds its grants/);
  assert.throws(() => compileWorkflowDefinition({ ...base, phases: { ...base.phases, lost: { ...base.phases.omega } } }, mechanicalRegistries), /unreachable phases/);
  assert.throws(() => compileWorkflowDefinition({ ...base, phases: { ...base.phases, alpha: { ...base.phases.alpha, transitions: { proceed: { target: "omega", authority: "transition" } } } } }, mechanicalRegistries), /self-grant authority/);
  assert.throws(() => parseYamlDocument("schema: 1\na: &x {b: 1}\nc: *x\n", "aliases"), /alias|Alias|maxAliasCount/i);
});

test("Recipe output contracts and phase obligations cannot be bypassed", () => {
  registerActions();
  const workflow = compileWorkflowDefinition({
    schema: 1,
    id: "test/recipe-obligation",
    version: "1.0.0",
    parametersSchema: {},
    initialPhase: "work",
    phases: {
      work: {
        purpose: "Produce the declared simulation report",
        actions: ["cad_simulate", "cad_commit_simulation", "transition"],
        grants: ["simulate", "transition"],
        writeScopes: ["project:recipe", "run:observation", "run:evidence", "run:state"],
        recordObligations: [],
        evidenceObligations: [{ ref: "simulation:case-1", type: "simulation", closeWith: "cad_commit_simulation", recipeKind: "simulation", requiredOutputs: ["report"] }],
        contextProviders: ["kernel.current-action"],
        hooks: [],
        transitions: { complete: { target: "done", requiresPhaseObligations: true } },
      },
      done: {
        purpose: "Done",
        actions: ["read"],
        grants: ["file_read"],
        writeScopes: [],
        recordObligations: [],
        evidenceObligations: [],
        contextProviders: ["kernel.current-action"],
        hooks: [],
        transitions: {},
        terminal: true,
      },
    },
  }, mechanicalRegistries);
  const registryContract = buildRegistryContract(mechanicalRegistries);
  const state = createHarnessRunState({ runId: "recipe-obligation", projectId: "project", workflow, registryContract });
  assert.throws(() => transitionRun(state, workflow, "complete"), /phase obligations remain unmet/);
  assert.throws(() => prepareRecipeObligation({ state, workflow, registryContract, obligationRef: "simulation:case-1", recipeKind: "simulation", requestedOutputs: [] }), /required obligation outputs.*report/);
  const binding = prepareRecipeObligation({ state, workflow, registryContract, obligationRef: "simulation:case-1", recipeKind: "simulation", requestedOutputs: ["report"] });
  assert.deepEqual(binding.requiredOutputs, ["report"]);
  const committed = commitBoundEvidence({
    state,
    workflow,
    registryContract,
    binding,
    evidence: {
      id: "evidence-1",
      obligationRef: binding.obligationRef,
      type: binding.evidenceType,
      path: "evidence/evidence-1.json",
      sha256: "a".repeat(64),
      workflowHash: workflow.hash,
      registryContractHash: registryContract.hash,
      createdAt: new Date(0).toISOString(),
    },
  });
  assert.equal(transitionRun(committed, workflow, "complete").status, "done");
});

test("cad_start pins intake and generic workflow_replace creates an immutable successor snapshot", async () => {
  registerActions();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-start-v7-"));
  try {
    const started = await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "new mechanical task" });
    assert.equal(started.workflow.id, "mechanical/intake");
    const successor = compileWorkflowDefinition(mechanicalWorkflowDefinition({ objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" }), mechanicalRegistries);
    const contract = buildRegistryContract(mechanicalRegistries);
    const state = replaceWorkflowSnapshot({ state: started.state, predecessor: started.workflow, successor, registryContract: contract, reason: "cad_route selected design/greenfield/part/engineering" });
    const run = new HarnessRunStoreV7(cwd, state.runId);
    const replaced = await run.replaceWorkflow({ expectedGeneration: started.head.generation, state, workflow: successor, registryContract: contract, event: { type: "WorkflowReplaced", data: { reason: "route" } } });
    assert.equal(replaced.state.phase, "requirements");
    assert.equal(replaced.state.workflow.history.length, 1);
    assert.equal(replaced.state.workflow.history[0]!.predecessorHash, started.workflow.hash);
    assert.notEqual(replaced.workflow.hash, started.workflow.hash);
    assert.equal((await run.load(mechanicalRegistries))!.workflow.hash, successor.hash);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Mechanical cad_route owns route interpretation and cad_reroute enforces downgrade authority", async () => {
  registerActions();
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-route-v7-"));
  try {
    await cadStart({ cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: "route test" });
    const part = { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" } as const;
    const assembly = { ...part, structure: "assembly" } as const;
    let loaded = await cadRouteV7({ cwd, route: part, reason: "initial route" });
    assert.equal((loaded.state.domainMetadata as any).route.structure, "part");
    loaded = await cadRerouteV7({ cwd, route: assembly, reason: "deliverable is an assembly" });
    assert.equal((loaded.state.domainMetadata as any).route.structure, "assembly");
    await assert.rejects(cadRerouteV7({ cwd, route: part, reason: "drop assembly duties" }), /requires authority/);
    const approved = await approveMechanicalRerouteV7(cwd);
    const authorityId = approved.state.authorities.at(-1)!.id;
    loaded = await cadRerouteV7({ cwd, route: part, reason: "user approved scope reduction" });
    assert.ok(loaded.state.authorities.find((item) => item.id === authorityId)?.consumedAt);
    assert.equal(loaded.state.workflow.history.length, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
