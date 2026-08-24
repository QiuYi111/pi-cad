# Generated model tool contract

> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.

## cad_build_step

Execute deterministic build123d source without accepting Project Head.

- Available phases: build, ready, modify, convert, audit, gap_closure, package
- Writes: outputs allowed by current phase policy
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/modeling.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_derive_analysis_model

Create a provenance-bound solver derivation.

- Available phases: review, ready, baseline, investigate, explain, concept, domain_analysis, source_baseline, compare, audit, gap_closure, package, final_review, system_concept, integration_review
- Writes: outputs allowed by current phase policy
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/modeling.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.
