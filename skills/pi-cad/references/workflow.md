# Workflow control

1. Start with `cad_route`; the compiled route determines phases and obligations.
2. Commit the full task contract with `cad_commit_requirements`. If authoritative information later changes it, use `cad_revise_requirements`; reroute when its assessment says the task shape changed.
3. Use only tools granted in the current phase. Read-only phases may author Recipes under `simulation/**`, not design CAD.
4. Commit required phase records before attempting downstream transitions.
5. Use `cad_transition` for workflow decisions, `cad_wait_for_user` for an actual user-owned choice, and `cad_declare_blocker` for an explicit external or authority dependency.
6. `cad_finish` is valid only after the harness reaches ready and every compiled obligation is satisfied.

Headless mode requires recorded assumptions or blockers. It does not authorize inventing missing dimensions, material properties, loads, boundary conditions, or manufacturing facts.

The requirements record selected by `state.requirementsVersion` is the authoritative task definition. When new authoritative information materially changes it, commit the complete replacement through `cad_revise_requirements` before rerouting or invoking engineering mutation tools. Record whether the Route changed and why. If reassessment locks routing, use only the exposed reassessment tools until `cad_reroute` succeeds; an erroneous changed assessment is recoverable only with the exact current requirements and an `unchanged` assessment. Missing external inputs block execution after the new canonical record exists—they never justify continuing against obsolete requirements.
