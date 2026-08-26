import assert from "node:assert/strict";
import { test } from "node:test";

import { bootstrapAgentApiContracts } from "../src/agent-api/bootstrap.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import {
  authorize,
  AuthorizationDeniedError,
  PermissionEngineV7,
  renderAuthorizationDenied,
  requireAuthorization,
  type Operation,
} from "../src/harness/permissions.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { commitEvidenceRef, createHarnessRunState, legalWorkflowTransitions, reviseEvidenceRef, transitionRun } from "../src/harness/reducer.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { AGENT_API_MUTATION_OPERATIONS } from "../src/agent-api/handlers.ts";
import type { EvidenceRefV7 } from "../src/harness/state.ts";

function fixture() {
  bootstrapAgentApiContracts();
  const workflow = compileWorkflowDefinition({
    schema: 1,
    id: "test/authorization",
    version: "1.0.0",
    parametersSchema: {},
    initialPhase: "concept_custom",
    phases: {
      concept_custom: {
        purpose: "Freeze a concept before detailed geometry",
        actions: ["cad_commit", "transition"],
        grants: ["image_generate", "observe", "transition"],
        writeScopes: ["run:state"],
        recordObligations: [{ ref: "concept", type: "workspace_commit", closeWith: "cad_commit" }],
        evidenceObligations: [],
        contextProviders: ["kernel.current-action"],
        hooks: [],
        transitions: { approved: { target: "build_custom", requiresPhaseObligations: true } },
      },
      build_custom: {
        purpose: "Build the accepted concept",
        actions: ["cad_build_step", "cad_commit", "transition"],
        grants: ["model_build", "observe", "transition"],
        writeScopes: ["project:deliverable", "run:state"],
        recordObligations: [], evidenceObligations: [{ ref: "build-visual", type: "visual", closeWith: "cad_build_step" }],
        contextProviders: ["kernel.current-action"], hooks: [],
        transitions: { done: { target: "terminal_custom" } },
      },
      terminal_custom: {
        purpose: "Terminal",
        actions: [], grants: [], writeScopes: [], recordObligations: [], evidenceObligations: [],
        contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
      },
    },
  }, mechanicalRegistries);
  const contract = buildRegistryContract(mechanicalRegistries);
  const state = createHarnessRunState({ runId: "run-auth", projectId: "project-auth", workflow, registryContract: contract });
  return { workflow, contract, state, permissions: new PermissionEngineV7(mechanicalRegistries, contract) };
}

test("workflow state is the authoritative operation policy for arbitrary phases", () => {
  const { workflow, state, permissions } = fixture();
  const image = authorize("image.generate", state, workflow, permissions);
  assert.equal(image.allowed, true);
  const probe = authorize("probe.run", state, workflow, permissions);
  assert.equal(probe.allowed, true);

  const model = authorize("model.build", state, workflow, permissions);
  assert.equal(model.allowed, false);
  if (model.allowed) return;
  assert.match(model.reason, /concept_custom/);
  assert.ok(model.legalNextActions.includes("cad_commit: concept"));
  assert.ok(!model.legalNextActions.some((item) => item.includes("approved")));
  assert.match(renderAuthorizationDenied(model), /Legal next actions/);
  assert.throws(() => requireAuthorization(model), AuthorizationDeniedError);
});

test("legal transitions exclude blocked events and candidate rebuilds revise primitive evidence", () => {
  const { workflow, contract, state } = fixture();
  assert.deepEqual(legalWorkflowTransitions(state, workflow), []);
  const closedConcept = {
    ...state,
    records: {
      concept: {
        obligationRef: "concept", type: "workspace_commit", path: "concept.json", sha256: "a".repeat(64),
        workflowHash: workflow.hash, createdAt: new Date().toISOString(),
      },
    },
  };
  const build = transitionRun(closedConcept, workflow, "approved");
  const first: EvidenceRefV7 = {
    id: "evidence-first", obligationRef: "build-visual", type: "visual", path: "evidence/first.json",
    sha256: "b".repeat(64), workflowHash: workflow.hash, registryContractHash: contract.hash, createdAt: new Date().toISOString(),
  };
  const admitted = commitEvidenceRef(build, workflow, contract, first);
  const second = { ...first, id: "evidence-second", path: "evidence/second.json", sha256: "c".repeat(64) };
  const revised = reviseEvidenceRef({ ...admitted, latestReview: {
    id: "stale-review", verdict: "pass", path: "review.json", profileId: "test", subjectHash: "d".repeat(64),
    workflowHash: workflow.hash, registryContractHash: contract.hash,
  } }, workflow, contract, second);
  assert.deepEqual(revised.evidence, [second]);
  assert.deepEqual(revised.staleEvidence, [first]);
  assert.equal(revised.latestReview, undefined);
});

test("authority roles and terminal status fail closed", () => {
  const { workflow, state, permissions } = fixture();
  const reviewerModel = authorize("model.build", state, workflow, permissions, "reviewer");
  assert.equal(reviewerModel.allowed, false);
  if (!reviewerModel.allowed) assert.match(reviewerModel.reason, /reviewer authority/);
  const reviewerCommit = authorize("workspace.commit", state, workflow, permissions, "reviewer");
  assert.equal(reviewerCommit.allowed, false);
  if (!reviewerCommit.allowed) assert.match(reviewerCommit.reason, /reviewer authority/);
  assert.equal(authorize("probe.run", state, workflow, permissions, "reviewer").allowed, true);

  const closedConcept = {
    ...state,
    records: {
      concept: {
        obligationRef: "concept", type: "workspace_commit", path: "concept.json", sha256: "a".repeat(64),
        workflowHash: workflow.hash, createdAt: new Date().toISOString(),
      },
    },
  };
  const build = transitionRun(closedConcept, workflow, "approved");
  assert.equal(authorize("model.build", build, workflow, permissions).allowed, true);
  const terminal = transitionRun(build, workflow, "done");
  const operations: Operation[] = [
    "workspace.commit", "model.build", "probe.run", "simulation.run", "image.generate", "review.submit", "workflow.transition",
  ];
  for (const operation of operations) assert.equal(authorize(operation, terminal, workflow, permissions).allowed, false, operation);
});

test("every active-run Agent API mutation is assigned to the unified authorization boundary", () => {
  assert.deepEqual(AGENT_API_MUTATION_OPERATIONS, {
    "workflow-advance": "workflow.transition",
    commit: "workspace.commit",
    probe: "probe.run",
    "model-build": "model.build",
    "simulation-run": "simulation.run",
    "review-submit": "review.submit",
  });
});
