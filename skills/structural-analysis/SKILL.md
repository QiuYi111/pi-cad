---
name: structural-analysis
description: Evaluate mechanical strength, stiffness, stability, reactions, fields, and sensitivities with traceable loads, constraints, materials, mesh checks, and managed torch-fem runtimes. Use when structural simulation supports a Pi-CAD acceptance claim or optimization decision.
---

# Structural analysis

Begin with the load path and free-body equilibrium, then choose a model no more complex than the claim requires.

- Read [references/modeling.md](references/modeling.md) for materials, loads, constraints, mesh, and derivation provenance.
- Read [references/credibility.md](references/credibility.md) for reactions, refinement, stress interpretation, and sensitivity validation.
- Copy `assets/recipes/torch-fem-linear-elastic/` into the project simulation tree for a managed Recipe-native starting point.
- Select `torch-fem-0.9-cu126` for production GPU work. The CPU runtime is only an explicit CI/debug/small-case choice and never a fallback.
- Use `pi-cad-tools` for simulate → observe → commit and managed `cad_optimize` execution.

Committed provenance does not turn an invalid structural idealization into an engineering pass.
