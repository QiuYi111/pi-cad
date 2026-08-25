---
name: pi-cad
description: Control Pi-CAD mechanical-engineering workflows from requirements through authoritative CAD, evidence-bound review, and delivery. Use for any task whose result is created, changed, analyzed, validated, or packaged through Pi-CAD.
---

# Pi-CAD

Treat the Current Action Card as authoritative for route, phase, Project Head, permissions, tools, obligations, and legal events. Normal operation must not inspect `src/**`.

Every successful mutation and recoverable protocol error returns a refreshed Current Action Card. Use only its listed actions and transitions; never guess event names from an older prompt.

- Read [references/generated/architecture.md](references/generated/architecture.md) for the code-defined architecture and [references/generated/workflow.md](references/generated/workflow.md) for all possible phase/event semantics.
- Read [references/cookbooks/workflow-records.md](references/cookbooks/workflow-records.md) when authoring records, review decisions, clarification, blockers, transitions, or Evidence commits.
- Read [references/model-and-delivery.md](references/model-and-delivery.md) when creating CAD, managing analysis derivations, accepting a candidate, or packaging outputs.
- Read [references/evidence.md](references/evidence.md) when probing, simulating, reviewing, or deciding whether an obligation is actually closed.
- For exact feature-level acceptance assertions that fixed observations do not expose, follow the programmable-observation guidance in the Evidence reference before review.
- Use the `pi-cad-tools` skill when concrete tool selection or arguments matter.
- Load only the engineering knowledge skill relevant to the physical question; domain meaning never belongs in Core.
