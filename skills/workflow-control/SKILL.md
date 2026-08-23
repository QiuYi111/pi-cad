---
name: workflow-control
description: Keep Pi-CAD's canonical requirements and Route synchronized when authoritative task information changes during a run.
---

# Pi-CAD Workflow Control

Treat the requirements record selected by `state.requirementsVersion` as the authoritative task definition.

When new authoritative information materially changes the task:

1. Call `cad_revise_requirements` with the complete replacement requirements before rerouting or using any engineering mutation tool.
2. State whether the existing Route is unchanged or changed and give the engineering reason.
3. If the Route changed, use only the tools exposed by the reassessment lock until `cad_reroute` succeeds.
4. If the changed assessment was mistaken, recover only by calling `cad_revise_requirements` with the exact current requirements and an `unchanged` assessment.

Never continue against obsolete requirements because an input artifact is unavailable. A valid new record becomes canonical first; missing external inputs block execution afterward.
