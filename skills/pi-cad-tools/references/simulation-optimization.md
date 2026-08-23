# Simulation and optimization tools

## Simulation

- `cad_simulate`: execute a `pi-sim.toml` Recipe using an advertised managed backend/runtime. It freezes compute files and declared inputs, then returns an images-first Observation. It creates no Evidence.
- `cad_sim_observe`: rerun only the declared observer over frozen raw results. It creates a new snapshot containing the exact manifest/observer program and hashes without mutating older observations. Any compute projection or input change requires a new simulation.
- `cad_commit_simulation`: reverify provenance and bind the selected immutable Observation to an existing `cad_simulate` case obligation. A later re-observation does not prevent committing an older intact snapshot.

Author Recipes only under `simulation/**`. Declare every project input. Use `outputs` only for additional exports; mandatory primary context cannot be suppressed.

Managed runtime families are OpenFOAM 14, SU2 8.5.0, and torch-fem 0.9. CUDA torch-fem is production and fails closed when CUDA/CuPy is unavailable. Confirm the trusted Solver health shows `requested device: cuda` and `actual device: cuda`; Recipe tables are supplementary. The CPU runtime is explicit, development-only, and never an automatic fallback.

## Optimization

- `cad_optimize`: managed torch-fem/NLopt topology optimization for the supported 2D rectangular domain. CUDA is default; CPU must be requested explicitly. The result is an optimization artifact, not CAD or Simulation Evidence.
