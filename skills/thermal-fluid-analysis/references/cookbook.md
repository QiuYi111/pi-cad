# OpenFOAM 14 and SU2 8.5 Recipe cookbook

## Applicable / not applicable

Use OpenFOAM for transient, multiphase, free-surface, and flexible finite-volume workflows. Use SU2 for suitable steady flow or solid-thermal cases with mature config/output handling. Do not choose a backend merely because a template exists.

## Environment and permissions

Copy an asset under `simulation/**`, use only a ready managed runtime, and use the locked Recipe Python command. Network and undeclared project files are unavailable during compute.

## Minimum valid input

Authoritative fluid/solid domain, surface mapping, units, materials/properties, operating states, complete boundary conditions/markers, initial state, mesh controls, convergence/conservation targets, and required exports.

## Complete working example

OpenFOAM: instantiate a steady-incompressible or transient-VOF asset, map every mesh patch into every field, run mesh validation before solve, record Courant/flux/mass health and refinement. SU2: instantiate the steady-flow or solid-thermal asset, replace marker/config placeholders, run real 8.5 `SU2_CFD -d`, solve, and export residual plus engineering monitor histories.

## Preflight

- OpenFOAM: patch names/types and field `boundaryField` coverage match; geometric constraint types match; `checkMesh` passes; initial fields and dimensions are explicit; time-step/Courant and conservation monitors exist.
- SU2: every marker is covered exactly; dimensionalization and restart policy are explicit; `SU2_CFD -d config.cfg` accepts the config; history/output names are verified for the selected solver; convergence checks residual and physical monitors.
- Both: mesh/time-step refinement and domain/boundary sensitivity are planned in proportion to the claim.

Official references: [OpenFOAM v14 boundaries](https://doc.cfd.direct/openfoam/user-guide-v14/boundary-conditions), [OpenFOAM v14 utilities](https://doc.cfd.direct/openfoam/user-guide-v14/standard-utilities), [SU2 tutorials](https://su2code.github.io/tutorials/home/), [SU2 custom output](https://su2code.github.io/docs_v7/Custom-Output/).

## Expected Observation

Primary field/contour image, conservation scalar, convergence timeseries/table, mesh/time-step/runtime health, and field artifacts. Multiphase work additionally exports interface evolution and relevant mass/volume balances.

## Common failures and next action

Uncovered patch/marker: repair complete mapping. Mesh failure: repair mesh/domain, not solver tolerances. Residual-only convergence: add physical monitors. Observer failure after a good solve: edit declared observer files and re-observe.

## Retry stop condition

Stop if geometry/material/operating boundary authority is missing. Do not repeat identical solver fingerprints or claim release PASS from a blocked template.

## Provenance and Evidence meaning

Core validates generic artifacts/provenance only. Recipe/review own the physical meaning, conservation limits, trapped-gas/force/temperature criteria, and PASS decision.
