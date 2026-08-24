# Generated simulation tool contract

> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.

## cad_simulate

Run a solver-native Recipe in a managed runtime; creates no Evidence.

- Available phases: review, ready, baseline, investigate, explain, concept, domain_analysis, source_baseline, compare, audit, gap_closure, package, final_review, system_concept, integration_review
- Writes: simulation/** and run-owned simulation storage
- Produces: SimulationRun; ObservationSnapshot
- Lifecycle: author Recipe → simulate → optional re-observe → inspect → commit
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/simulation-recipes.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_sim_observe

Re-run only the observer over a frozen SimulationRun.

- Available phases: review, ready, baseline, investigate, explain, concept, domain_analysis, source_baseline, compare, audit, gap_closure, package, final_review, system_concept, integration_review
- Writes: simulation/** and run-owned simulation storage
- Produces: ObservationSnapshot
- Lifecycle: author Recipe → simulate → optional re-observe → inspect → commit
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/simulation-recipes.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.
