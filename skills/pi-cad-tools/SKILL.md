---
name: pi-cad-tools
description: Select and use Pi-CAD public operations correctly, including workflow control, CAD build and delivery, unified probes, Recipe-native simulation, analysis derivations, and optimization. Use when deciding which Pi-CAD operation to call or how its lifecycle behaves.
---

# Pi-CAD tools

The generated references are the code-defined active public surface. The Current Action Card is authoritative for what is callable now; the live tool schema is authoritative for exact parameters. Normal use must not inspect `src/**`.

- Read `references/generated/<category>.md` for the exact control, model, probe, simulation, optimization, or deliverable catalog generated from code.
- Read [references/cookbooks/probe.md](references/cookbooks/probe.md) for strict target selection, immutable observations, and paged detail.
- Read [references/cookbooks/simulation-recipes.md](references/cookbooks/simulation-recipes.md) before authoring or repairing any Recipe/backend run.
- Read [references/cookbooks/modeling.md](references/cookbooks/modeling.md), [optimization.md](references/cookbooks/optimization.md), or [deliverable.md](references/cookbooks/deliverable.md) for those authored objects.

Do not guess a tool/event name or retry an unchanged structured failure. Follow the action card and returned `suggestedActions`.
