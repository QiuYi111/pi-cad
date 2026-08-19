---
name: thermal-fluid-analysis
description: >
  Use when mechanical CAD acceptance depends on fluid flow, pressure,
  Mach number, temperature, heat transfer, nozzle behavior, or related
  thermal-fluid physics. Guides how to formulate and interpret Pi-CAD
  flow/thermal evidence without replacing the model's CFD knowledge.
---

# Thermal-fluid analysis

Use the smallest physical model that can actually answer the engineering claim.

Before assigning boundary conditions, inspect the relevant solid or
fluid-domain surfaces with cad_inspect_surfaces. Surface IDs are geometric
selectors, not semantic labels; decide inlet/outlet/wall meaning yourself.

Do not invent operating conditions. Missing inlet total state, outlet
pressure, material thermal properties, heat flux, or other
acceptance-critical boundary conditions must remain explicit unknowns or
blocked_external.

Use cad_simulate_flow for flow quantities and cad_simulate_thermal for
solid temperature/heat-flow quantities. Solver output is evidence, not
judgment.

Check numerical credibility before interpreting engineering meaning:
convergence, mass/energy balance, mesh sensitivity when the quantitative
result is acceptance-critical.

Do not overclaim the modeled scope. A nozzle calculation with prescribed
combustor-exit total conditions can support a nozzle outlet-Mach claim; it
does not prove combustion performance, compressor performance, total engine
thrust, or full-engine operability.

When geometry changes, rerun every required current-version thermal/fluid
case.
