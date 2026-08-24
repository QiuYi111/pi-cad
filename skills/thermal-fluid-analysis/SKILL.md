---
name: thermal-fluid-analysis
description: >
  Analyze mechanical designs whose acceptance depends on fluid flow,
  pressure, temperature, heat transfer, conjugate effects, or related
  thermal-fluid physics. Use for OpenFOAM or SU2 Recipe selection,
  boundary-condition discipline, numerical credibility, and result review.
---

# Thermal-fluid analysis

Use the smallest physical model that can answer the acceptance claim, then preserve the full Recipe and runtime provenance.

- Read [references/model-selection.md](references/model-selection.md) to choose OpenFOAM versus SU2 and define model scope.
- Read [references/boundary-conditions.md](references/boundary-conditions.md) before assigning surface semantics, operating states, or material properties.
- Read [references/credibility.md](references/credibility.md) for convergence, conservation, refinement, and interpretation checks.
- Read [references/cookbook.md](references/cookbook.md) for backend-specific authoring/preflight/failure recovery.
- Copy a template from `assets/recipes/` only after replacing its explicit surface and input placeholders.
- Use the generated `pi-cad-tools` contract for the current lifecycle.

Missing acceptance-critical operating data or authoritative geometry is `blocked_external`, never permission to fabricate a release verdict.
