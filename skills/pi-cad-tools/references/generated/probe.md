# Generated probe tool contract

> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.

## cad_probe

Inspect an artifact through a strict typed or programmable read-only probe.

- Available phases: build, review, ready, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Writes: run-owned observation storage only
- Produces: Immutable ObservationSnapshot
- Lifecycle: resolve subject → observe → inspect summary → recall details when needed
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/probe.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_recall_observation

Recover an observation summary, visuals, or paged detail collection.

- Available phases: build, review, ready, baseline, investigate, explain, plan, modify, concept, domain_analysis, source_baseline, transform_plan, convert, compare, audit, gap_closure, package, final_review, system_concept, assembly_design, interface_design, part_design, integration_review
- Writes: run-owned observation storage only
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: resolve subject → observe → inspect summary → recall details when needed
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/probe.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.
