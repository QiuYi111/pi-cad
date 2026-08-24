# Generated optimization tool contract

> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.

## cad_optimize

Produce a managed torch-fem optimization artifact.

- Available phases: review, compare, gap_closure, package, integration_review
- Writes: outputs allowed by current phase policy
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/optimization.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.
