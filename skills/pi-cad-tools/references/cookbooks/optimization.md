# Optimization cookbook

## Applicable / not applicable

Use a `kind: optimization` Recipe for the supported differentiable topology domain and declared SIMP/MMA contract. It produces an immutable optimization result/artifact, not CAD acceptance or Simulation Evidence.

## Environment and permissions

Production uses the ready managed CUDA runtime. CPU is permitted only when explicitly selected for development/small cases; it has a distinct runtime identity and never results from fallback.

## Minimum valid input

In `pi-recipe.yaml`, declare the pinned torch-fem runtime, explicit input files, a named action closure, observer closure, primary result export, optional density/history exports, and resource limits. The input/spec declares domain bounds/resolution, `float64` material properties, objective, volume constraint, iterations/penalty, device, loads, and constraints.

## Complete working example

Call `cad_optimize({recipe, outputs:["density","history"]})`, inspect the immutable Observation and requested/actual device, reconstruct selected density into robust build123d geometry, commit a CAD candidate, then run case-specific simulation again.

## Preflight

Confirm CUDA runtime is advertised ready, actualDevice is CUDA, volume fraction is valid, loads/supports are physically meaningful, and the mesh is adequate for the design scale.

## Expected Observation

Density/surface artifacts, objective/volume history, iteration count, and exact accelerator/runtime identity. Sensitivity work should compare autograd and finite difference.

## Common failures and next action

CUDA unavailable means unavailable, not CPU fallback. Divergence or checkerboarding requires changing the optimization contract/filter/mesh, not blindly increasing iterations.

## Retry stop condition

Stop identical optimizer retries without a changed spec. Stop if GPU qualification or physical load/support authority is absent.

## Provenance and Evidence meaning

Optimization provenance binds the spec and runtime. Reconstructed CAD and its new simulations are independently reviewed.
