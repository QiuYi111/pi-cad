# Generated control tool contract

> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.

## cad_start

Start a generic v7 run from the project-selected immutable workflow.

- Available phases: conditional only
- Availability: Only when no active run exists; Mechanical tasks normally start with cad_route.
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_route

Select the route that compiles the workflow and obligations.

- Available phases: intake
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_reroute

Change route without bypassing obligations; downgrades require authority.

- Available phases: build, review, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_requirements

Commit the first complete mission and acceptance contract.

- Available phases: requirements
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_revise_requirements

Replace requirements after authoritative information changes.

- Available phases: requirements, build, review, ready, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Availability: After the first requirements commit.
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_frame_context

Record the interpretation of an imported coordinate frame.

- Available phases: baseline, source_baseline
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_plan

Commit the implementation or investigation plan owed by this phase.

- Available phases: review, plan, transform_plan, compare, audit, gap_closure, package, part_design, integration_review
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_assembly_design

Commit modules, datums, ownership, and assembly sequence.

- Available phases: audit, assembly_design
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_interface_contracts

Commit locating, DOF, fit, fastening, and access contracts.

- Available phases: audit, interface_design
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_candidate

Build and propose source-authored CAD with automatic observations.

- Available phases: build, modify, convert, gap_closure
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_submit_for_review

Submit the immutable candidate for independent final verification.

- Available phases: review, compare, integration_review, final_review
- Availability: Only on a final accepted edge when independent review is enabled.
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_transition

Apply one legal decision event from the compiled workflow.

- Available phases: build, review, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_wait_for_user

Pause an interactive workflow for a user-owned decision.

- Available phases: requirements, build, review, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Availability: Interactive workflows only.
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_defer_clarification

Record a bounded headless assumption and continue.

- Available phases: requirements, build, review, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Availability: Headless workflows only.
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_declare_blocker

Stop honestly on missing authority or indispensable external input.

- Available phases: requirements, build, review, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Availability: Headless workflows only.
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_finish

Close a ready workflow after deterministic checks.

- Available phases: ready
- Writes: workflow state, records, and journal
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_commit_simulation

Bind one immutable run/observation to a simulation case obligation.

- Available phases: review, ready, baseline, investigate, explain, concept, domain_analysis, source_baseline, compare, audit, gap_closure, package, final_review, system_concept, integration_review
- Writes: workflow state, records, and journal
- Produces: Simulation EvidenceRef
- Lifecycle: author Recipe → simulate → optional re-observe → inspect → commit
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad/references/cookbooks/workflow-records.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.
