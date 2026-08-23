---
name: thermal-fluid-analysis
description: >
  Use when mechanical CAD acceptance depends on fluid flow, pressure,
  Mach number, temperature, heat transfer, nozzle behavior, or related
  thermal-fluid physics. Guides Recipe-native Pi-CAD simulation,
  observation, credibility checks, and explicit evidence commit without
  encoding project physics in Core.
---

# Thermal-fluid analysis

Use the smallest physical model that can actually answer the engineering claim.

Before assigning boundary conditions, inspect the relevant solid or
fluid-domain surfaces with cad_probe preset=surfaces. Surface IDs are geometric
selectors, not semantic labels; decide inlet/outlet/wall meaning yourself.

Do not invent operating conditions. Missing inlet total state, outlet
pressure, material thermal properties, heat flux, or other
acceptance-critical boundary conditions must remain explicit unknowns or
blocked_external.

Author a solver-native Recipe under `simulation/**`. Put physics, materials,
boundary conditions, meshing, solver controls, post-processing, and
project-specific metrics in that Recipe, not in Pi-CAD tool arguments. Its
strict `pi-sim.toml` must declare every project input and export observations
as `image`, `scalar`, `timeseries`, `table`, `field`, or `artifact`.

Use the V2 lifecycle:

1. Call `cad_simulate` with an available backend/runtime and the Recipe path.
2. Inspect the images-first Observation and solver health. If only declared
   observation files need revision, edit them and call `cad_sim_observe`;
   changing compute files or inputs requires a new simulation run.
3. Call `cad_commit_simulation` with the exact required `caseId` only after
   selecting a complete immutable Observation. Simulate and observe alone do
   not create Evidence.

The typed `cad_simulate_flow` and `cad_simulate_thermal` tools are deprecated
compatibility wrappers. Do not use them for newly authored cases.

Check numerical credibility before interpreting engineering meaning:
convergence, mass/energy balance, mesh sensitivity when the quantitative
result is acceptance-critical. A committed simulation records provenance; it
does not by itself mean the engineering result passes. A successfully
executed engineering FAIL may still be committed for audit, while interrupted
or provenance-invalid runs may not.

Do not overclaim the modeled scope. A nozzle calculation with prescribed
combustor-exit total conditions can support a nozzle outlet-Mach claim; it
does not prove combustion performance, compressor performance, total engine
thrust, or full-engine operability.

When geometry, declared inputs, runtime, or compute Recipe content changes,
rerun every required current-version thermal/fluid case. Missing authoritative
inputs must produce `blocked_external`, never a fabricated release verdict.
