---
name: parametric-cad-modeling
description: Create robust, editable, STEP-first parametric mechanical CAD with stable references, meaningful parameters, and deterministic regeneration. Use when deciding feature order, parameter structure, topology robustness, or model-authoring strategy.
---

# Parametric CAD modeling

Model design intent, not a single frozen shape. Keep authoritative dimensions named, minimize fragile references, and regenerate deterministically before acceptance.

- Read [references/model-structure.md](references/model-structure.md) for parameter organization, datum strategy, and feature ordering.
- Read [references/robustness.md](references/robustness.md) for topology stability, validation, and STEP delivery.
- Read [references/cookbook.md](references/cookbook.md) and start from the part/assembly assets for executable authoring examples.
- Read [references/build123d-patterns.md](references/build123d-patterns.md) only when writing or repairing build123d source.
- Read [references/repair-and-check.md](references/repair-and-check.md) after a failed build, suspicious render, or fragile regeneration.
- Use `pi-cad-tools` for the current code-generated tool contract.

Do not encode acceptance-critical dimensions as unexplained numeric literals or depend on generated face order remaining stable.
