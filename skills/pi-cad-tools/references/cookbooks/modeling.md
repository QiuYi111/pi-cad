# Modeling and derivation cookbook

## Default: `cad.part` (FreeCAD)

New parts and assemblies are modeled with `cad.part`: JSON ops on a parametric `.FCStd` document, one part per document, one assembly per document (`link`, `import_step`, `joint`). Every `apply` returns the seven standard views and a change summary, and closes the same build evidence as a managed build. Start from `parametric-cad-modeling/assets/freecad-part` or `freecad-assembly`; the op reference is `parametric-cad-modeling/references/freecad-part-ops.md`. If FreeCAD is not installed, the call fails with `FREECAD_NOT_INSTALLED`: tell the user to run `npm run setup:freecad` (about 4.2 GB, once) and stop.

The rest of this cookbook describes the build123d compatibility path.

## Applicable / not applicable

Use, on the compatibility path, for deterministic build123d execution and provenance-bound analysis derivations. Use the parametric modeling skill for source design. Do not treat a solver convenience model as Project Head.

## Environment and permissions

Author Python/model sources only in source-authoring phases; simulation-only grants permit only `simulation/**`. Execute Python through the project uv environment.

## Minimum valid input

Build source must deterministically write the declared STEP output and avoid hidden host/environment dependencies. A derivation declares authoritative source, exact output, operations, assumptions, and both hashes.

## Complete working example

Copy the part/assembly asset, replace named dimensions and datums, run a deterministic build, probe the output, then propose through the candidate lifecycle. For analysis, create the simplified/fused artifact in source work, create its derivation record, and declare both record and artifact as Recipe inputs.

## Preflight

- Stable selectors/geometry conditions, explicit datums/Locations, semantic labels, units.
- No iterative one-solid-at-a-time fuse for large repeated sets.
- Output exists and is inside project; source and artifact hashes are current.
- Derivation assumptions do not silently change material/load-bearing topology.

## Expected Observation

Build returns a deterministic artifact and provenance. Probe returns its immutable geometry/visual snapshot. Derivation returns a record whose source/output hashes can be verified at simulation commit.

## Common failures and next action

Repair source syntax/build errors in source phase; use a local geometry review edge only for an actual candidate defect. If the solver input needs a materially different authored simplification, revise source and regenerate its derivation.

## Retry stop condition

Do not rerun unchanged failing source. Stop if requirements/datum ownership are unresolved.

## Provenance and Evidence meaning

A build artifact is not accepted Project Head. A derivation proves lineage, not physical validity. Candidate review and simulation commit remain separate.
