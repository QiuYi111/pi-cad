---
name: mechanical-design
description: Develop mechanical concepts and part designs from loads, constraints, interfaces, failure modes, and measurable acceptance criteria. Use for general mechanical engineering decisions that are not primarily CAD syntax, assembly architecture, manufacturing process, or one simulation discipline.
---

# Mechanical design

Translate requirements into load paths, interfaces, failure modes, and testable geometry. Prefer simple mechanisms with explicit assumptions and inspectable acceptance criteria.

- Read [references/design-reasoning.md](references/design-reasoning.md) for requirement decomposition, free-body reasoning, material selection, and safety factors.
- Read [references/verification.md](references/verification.md) for failure-mode-driven evidence and uncertainty handling.
- Read [references/mechanisms.md](references/mechanisms.md) for motion, stops, retention, stability, and mechanism sanity checks.
- Pair with `parametric-cad-modeling`, `assembly-design`, or `design-for-manufacturing` when those domains dominate the next decision.

Do not hide unresolved operating loads, environments, lifetime, or regulatory constraints inside arbitrary dimensions.
