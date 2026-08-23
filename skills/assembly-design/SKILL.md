---
name: assembly-design
description: Design and validate mechanical assemblies, interfaces, datums, locating schemes, installation sequences, and tolerance-sensitive mating relationships. Use when a Pi-CAD deliverable has multiple interacting parts or bought-in components.
---

# Assembly design

Work datum-first and contract-first. A valid assembly model explains how every part is located, constrained, installed, serviced, and verified.

- Read [references/architecture.md](references/architecture.md) for module decomposition, datum systems, installation sequence, and service access.
- Read [references/interfaces.md](references/interfaces.md) for degree-of-freedom budgets, fits, fasteners, seals, and bought-in component interfaces.
- Read [references/verification.md](references/verification.md) for interference interpretation, clearance evidence, and tolerance-sensitive checks.
- Use `pi-cad` for controlled assembly/interface records and `pi-cad-tools` for the active probe and model tools.

Do not invent supplier interfaces or silently change committed contracts to fit authored geometry.
