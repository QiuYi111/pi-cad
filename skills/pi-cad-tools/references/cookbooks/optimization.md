# Optimization cookbook

## Applicable / not applicable

Use only for the supported differentiable 2D rectangular topology domain and declared SIMP/MMA contract. It produces an optimization artifact, not CAD or Simulation Evidence.

## Environment and permissions

Production uses the ready managed CUDA runtime. CPU is permitted only when explicitly selected for development/small cases; it has a distinct runtime identity and never results from fallback.

## Minimum valid input

Declare domain bounds/resolution, `float64` material properties, compliance objective, one volume-fraction constraint, optimizer iterations/penalty, explicit device, loads, and constraints.

## Complete working example

Run the optimization in CUDA, inspect requested/actual device and convergence, reconstruct the selected density into robust build123d geometry, commit a CAD candidate, then run case-specific simulation again.

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
