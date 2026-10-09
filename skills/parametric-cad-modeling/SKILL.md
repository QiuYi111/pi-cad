---
name: parametric-cad-modeling
description: Create robust, editable, STEP-first parametric mechanical CAD with stable references, meaningful parameters, and deterministic regeneration. Use when deciding feature order, parameter structure, topology robustness, or model-authoring strategy.
---

# Parametric CAD modeling

Model design intent, not a single frozen shape. Keep authoritative dimensions named, minimize fragile references, and regenerate deterministically before acceptance.

- Read [references/freecad-part-ops.md](references/freecad-part-ops.md) first: `cad.part` is the default way to model a part or an assembly. It has the JSON ops, role-named faces, change summaries, assemblies (`link`, `import_step`, `joint`) and pose sweeps.
- Start from the assets: [assets/freecad-part](assets/freecad-part/README.md) for one part, [assets/freecad-assembly](assets/freecad-assembly/README.md) for parts in separate documents linked into an assembly.
- Read [references/model-structure.md](references/model-structure.md) for parameter organization, datum strategy, and feature ordering.
- Read [references/robustness.md](references/robustness.md) for topology stability, validation, and STEP delivery.
- Read [references/repair-and-check.md](references/repair-and-check.md) after a failed build, suspicious render, or fragile regeneration.
- Compatibility only: [references/build123d-patterns.md](references/build123d-patterns.md) and [references/cookbook.md](references/cookbook.md) (with `assets/build123d-part` and `assets/build123d-assembly`) apply when editing an existing build123d source or when the ops cannot express a shape. Say which op is missing when you use them for that reason.
- Use `pi-cad-tools` for the current code-generated tool contract.

Do not encode acceptance-critical dimensions as unexplained numeric literals or depend on generated face order remaining stable.
