# SPEC-04 manual E2E template

This benchmark contains the complete OpenFOAM 14 case generator and runner for
Stage I injection, Stage II equivalent plug pulse and no-flow relaxation, plus
mesh convergence, robustness sweeps and release-report materialization. The
solver implementation is repository-owned; authoritative manufacturing CAD,
private materials, surface mapping and the Rev1 spec pack remain external.

Import the four authoritative inputs with `prepare_inputs.py`. The expected
JSON shapes are documented by `input-schemas/`; the Rev1 directory must contain
`release-criteria.json`. Until those inputs are present, the Recipe writes
`blocked_external`, returns a partial non-committable Observation, and never
emits `SIMULATION_RELEASE_PASS`.

The bundled `case_driver.py` converts the declared STEP flow-domain faces into
named triangulated patches, builds a snappyHexMesh case, executes injection,
equivalent plug pulse and relaxation stages, and writes scenario metrics. It
does not invent geometry, materials, thresholds or project engineering PASS.
Except for `surface-mapping.lengthUnit`, materials, velocity, time, pressure,
force, volume and displacement values use SI units.
