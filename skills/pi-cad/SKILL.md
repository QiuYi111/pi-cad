---
name: pi-cad
description: Control Pi-CAD mechanical-engineering workflows from requirements through authoritative CAD, evidence-bound review, and delivery. Use for any task whose result is created, changed, analyzed, validated, or packaged through Pi-CAD.
---

# Pi-CAD

Treat the Current Action Card as authoritative for route, phase, Project Head, permissions, tools, obligations, and legal events. Normal operation must not inspect `src/**`.

For structural, flow, or thermal work, discover managed Pi-CAD runtimes before touching the Python environment. Pi-CAD provides Recipe-backed OpenFOAM 14, SU2 8.5.0, and torch-fem 0.9 CPU/CUDA runtimes; use `await cad.workflow.current()` plus `pi-cad-tools/references/cookbooks/simulation-recipes.md` to select and preflight one. Python imports describe Recipe authoring only, never solver availability.

- Read [references/generated/architecture.md](references/generated/architecture.md) for the code-defined architecture and [references/generated/workflow.md](references/generated/workflow.md) for all possible phase/event semantics.
- Read [references/cookbooks/workflow-records.md](references/cookbooks/workflow-records.md) when authoring records, review decisions, clarification, blockers, transitions, or Evidence commits.
- Read [references/model-and-delivery.md](references/model-and-delivery.md) when creating CAD, managing analysis derivations, accepting a candidate, or packaging outputs.
- Read [references/evidence.md](references/evidence.md) when probing, simulating, reviewing, or deciding whether an obligation is actually closed.
- Use the `pi-cad-tools` skill when concrete tool selection or arguments matter.
- Load only the engineering knowledge skill relevant to the physical question; domain meaning never belongs in Core.
