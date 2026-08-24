# Simulation Recipe cookbook

## Applicable / not applicable

Use for all new solver work. The `recipe` argument is the Recipe directory containing `pi-sim.toml`, never the manifest file itself. A Recipe owns physics, material, mesh, boundaries, solver controls, and project metrics. Core owns managed execution, generic exports, immutable observations, provenance, and explicit Evidence commit.

## Environment and permissions

Author only under `simulation/**` unless the action card permits broader source work. Choose only a runtime shown ready in the card. Formal execution is bubblewrap-isolated, network-free, quota/CPU/RAM/PID/wall-time bounded. Recipe Python is always:

```bash
uv run --offline --frozen --project "$PI_CAD_PYTHON_PROJECT" python ...
```

## Minimum valid input

```toml
schema = 1
entrypoint = "./Allrun"
observe = "uv run --offline --frozen --project \"$PI_CAD_PYTHON_PROJECT\" python observe.py"
nonvisual = false
inputs = ["../../models/domain.step"]
observation_files = ["observe.py"]

[exports.primary_view]
type = "image"
primary = true

[exports.metric]
type = "scalar"
primary = true
unit = "1"
```

`Allrun` must be executable and fail on solver/preflight error. The observer writes strict JSON to `PI_SIM_OBSERVATION_FILE` and references only files inside the run workspace.

## Complete working example

Copy the closest backend asset into `simulation/<case>/`, replace explicit input paths/physics, run the Recipe preflight once, simulate, inspect the images/quantitative health, optionally change only declared observation files and re-observe, then commit the exact run/observation to the existing case obligation. Compute files or declared inputs changed? Create a new run.

## Backend preflight

- OpenFOAM 14: every mesh patch appears in every field `boundaryField`; constraint patch types match; run `checkMesh`; record Courant/flux/conservation health and refinement. Use function objects/post-processing rather than parsing uncontrolled console prose. See the [v14 boundary-condition guide](https://doc.cfd.direct/openfoam/user-guide-v14/boundary-conditions) and [standard utilities](https://doc.cfd.direct/openfoam/user-guide-v14/standard-utilities).
- SU2 8.5.0: derive from a version-compatible official tutorial; cover every marker; execute the real `SU2_CFD -d config.cfg` dry run; make dimensionalization/restart explicit; monitor residuals and engineering quantities. See [tutorials](https://su2code.github.io/tutorials/home/) and [custom output](https://su2code.github.io/docs_v7/Custom-Output/).
- torch-fem 0.9.0: use `float64`, explicit material/load/constraint/device, reaction balance, mesh refinement, field exports, and sensitivity gradient comparison where applicable. CUDA production never falls back; CPU is a separate development runtime identity. See the [official repository](https://github.com/meyer-nils/torch-fem).

## Expected Observation

Primary images first, then bounded scalar/series/table/health/diagnostics and artifact refs. Every run also creates an indexed context observation; page its `entrypoint.stdout`, `entrypoint.stderr`, `observer.stdout`, `observer.stderr`, and export collections when needed.

## Common failures and next action

- Preflight list: fix all reported manifest/input/permission/runtime issues before retry.
- Same fingerprint: retry only after the listed Recipe/input/runtime state changed.
- Compute failure: page full logs, change compute files, then create a new run.
- Observer/validation failure: edit only frozen `observation_files`/export declaration and re-observe.
- CUDA unavailable: stop or explicitly select development CPU; never allow automatic fallback.
- Missing external engineering input: clarify or report `blocked_external`; never manufacture release PASS.

## Retry stop condition

Stop identical retries after one repeated fingerprint. Stop if the required managed runtime or authoritative external input is unavailable. Qualification gates are opt-in and are not substitutes for case-specific evidence.

## Provenance and Evidence meaning

Simulate and observe create immutable facts, not Evidence. Commit re-verifies runtime, Recipe, inputs, raw project, observer program, current case, and authoritative artifact/derivation. Evidence existence records provenance; final review determines engineering PASS.
