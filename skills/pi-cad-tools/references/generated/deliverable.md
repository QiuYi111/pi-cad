# Generated deliverable tool contract

> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.

## cad_export

Create geometry sidecars without changing Project Head.

- Available phases: build, ready, modify, convert, audit, gap_closure, package
- Writes: outputs allowed by current phase policy
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/deliverable.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_generate_drawing

Generate a structured drawing from declared intent.

- Available phases: build, ready, modify, convert, audit, gap_closure, package
- Writes: outputs allowed by current phase policy
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/deliverable.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.

## cad_render_scene

Create presentation assets from an explicit scene specification.

- Available phases: build, ready, modify, convert, audit, gap_closure, package
- Writes: outputs allowed by current phase policy
- Produces: Declared tool artifact or canonical workflow state
- Lifecycle: Use only when exposed by the action card; inspect returned state/artifacts.
- Success means: The declared state/artifact operation completed; engineering PASS still requires workflow review.
- Cookbook: `pi-cad-tools/references/cookbooks/deliverable.md`
- Parameter contract: embedded TypeBox JSON schema in assets/agent-contract.json

The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.
