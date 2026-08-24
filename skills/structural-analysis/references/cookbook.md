# torch-fem 0.9 structural Recipe cookbook

## Applicable / not applicable

Use linear elasticity only when material/model assumptions support it and deformation/contact/nonlinearity do not invalidate the acceptance claim. Use the sensitivity asset only when differentiability is part of the decision.

## Environment and permissions

Copy under `simulation/**`. Production selects the ready CUDA runtime; explicit CPU is development-only. The runtime must report matching requested/actual device, torch-fem 0.9.0, pinned PyTorch/CuPy, GPU model/VRAM/compute capability, and a real sparse-solve qualification.

## Minimum valid input

Authoritative/derived geometry plus derivation record, `float64`, units, explicit elastic material, mesh size/order, load regions/resultants, constraint regions/DOFs, and expected equilibrium checks.

## Complete working example

Use `assets/recipes/torch-fem-linear-elastic/`: replace `case.json` geometry/material/load/constraint placeholders, keep device sourced only from `PI_SIM_ACCELERATOR`, simulate in CUDA, inspect deformation/von-Mises images, displacement/stress/reaction scalars, fields and health, then check refinement and reaction balance before commit. Use the sensitivity asset to compare autograd with finite differences.

## Preflight

- Validate free-body load/resultant/moment and prevent rigid-body modes without overconstraint.
- Check material units and Poisson ratio.
- Refine mesh against displacement/reaction and away from singular peak stress.
- Require actualDevice to equal requestedDevice; no CUDA-to-CPU fallback.
- For sensitivity, report step size and relative gradient mismatch.

## Expected Observation

Deformation/stress images; maximum displacement/von Mises; reaction magnitude/balance; displacement/stress/strain field artifacts; mesh/solver/accelerator health; optional sensitivity artifact.

## Common failures and next action

Singular solve: repair physical constraints. Imbalance: repair loads/constraints/numerics. Non-convergent refinement: improve mesh/model. CUDA unavailable: stop or explicitly select development CPU with a distinct identity.

## Retry stop condition

Stop if load/material/constraint authority is missing or if the model class is invalid. Do not rerun unchanged singular/divergent cases.

## Provenance and Evidence meaning

Evidence binds the exact Recipe, derivation, runtime/device, inputs, fields, and observer. Review determines whether the idealization supports the claim.
