# Generated Pi-CAD architecture contract

> Generated from executable registries. Do not edit; run `npm run generate:agent-contract`.

Normal Pi-CAD use relies on this contract, the current action card, and cookbooks. Reading `src/**` is not an operating step.

## Layers

- **Control Plane** — Compile routes, enforce phases/obligations, and bind Evidence.
- **Context Runtime** — Project canonical state, action cards, observation memory, and compaction.
- **Observation Layer** — Return bounded semantic context plus immutable detail.
- **Capability Modules** — MODEL, PROBE, SIMULATE, optimization, and deliverable execution.
- **Skills/Cookbooks** — Teach operation and authoring without duplicating runtime state.

## Invariants

- Project Head changes only through accepted workflow closure.
- Tool success is not engineering acceptance.
- Observations are immutable and hash-bound.
- Simulation creates Evidence only through cad_commit_simulation.
- The current action card is authoritative for tools, writes, obligations, and events.
