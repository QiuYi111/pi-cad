# ReifyExport: Autodesk Fusion add-in

Executes Reify canonical feature JSON (`reify.features/1`) in Fusion and exports `.f3d` plus a STEP file for the equivalence check. The wire contract is `docs/cad-transfer/protocol.md` (sections 1 and 2). Version 0.1.0.

## Install

Copy the folder `ReifyExport/` to:

- Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\ReifyExport`
- macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/ReifyExport`

The desktop app reads `ReifyExport.manifest` (`version`) to show the installed version. `ReifyExport.py` `__version__` must match (a test enforces it).

## Enable

In Fusion: Shift+S (Scripts and Add-Ins), tab Add-Ins, select ReifyExport, Run. Tick "Run on Startup" so it starts with Fusion. The manifest has `runOnStartup: false` as a default.

## Job protocol (summary)

Job root: Windows `%LOCALAPPDATA%\Reify\transfer`, macOS `~/Library/Application Support/Reify/transfer`. Env `REIFY_TRANSFER_ROOT` overrides it.

- Add-in writes `fusion/heartbeat.json` every 5 s (atomic): pid, version, app, `signedIn`, `updatedAt`.
- Dispatcher writes `fusion/inbox/<jobId>.json` (tmp + rename). The add-in claims it by renaming it to `fusion/outbox/<jobId>/job.json`, builds, and writes `part.f3d`, `check.step`, `log.txt`, and last `result.json` (atomic).
- Result errors: `{code: EXECUTOR_FAILED | UNSUPPORTED_OP | BUSY, message, feature, step}`. `feature` is the Reify semantic name. Steps: `plan`, `document`, `sketch` (sketch failures report the feature that uses it), `profile`, `extrude`, `pattern`, `export`, `timeout`, `job`.
- One job at a time. Plan errors (unsupported feature) are raised before Fusion is touched.

## Code layout

Pure Python, no `adsk` import, unit tested with `python3 -m unittest discover -s tests/fusion_addin -v`:
`jobroot.py`, `jobs.py` (claim, validate, result, error mapping), `plan.py`, `profiles.py` (even-odd), `geom.py`, `workers.py` (watcher and heartbeat threads).
Thin Fusion layer: `fusion_exec.py` (all `adsk` calls), `ReifyExport.py` (run/stop, custom events).

Threading: the watcher thread only calls `app.fireCustomEvent`. The event handler runs on the Fusion main thread and does all API calls. The heartbeat thread uses a cached snapshot (refreshed by a tick event and after each job), so the heartbeat stays fresh while a long job blocks the main thread.

## What it builds (0.1.0)

- `pad` (length, midplane, reversed via `direction`), `pocket` (length or through_all): P0.
- `hole` (through_all, plain; cut-extrude of circles of `diameter` at `positions`, or at the circle centres of the referenced sketch), `polar_pattern` (CircularPatternFeature): P1. Both live behind `plan.build_plan(..., enable_p1=...)` and `P1_TYPES`.
- Sketch geometry: line, arc, circle, polyline. Each profile region is chosen with the even-odd rule (see `profiles.py`); profiles are never selected blindly.
- Anything else raises `UNSUPPORTED_OP` naming the feature (and the option). Nothing is skipped silently.

Decisions and limits:

- A second `pad` joins the existing body (first pad is a new body). A `pocket`/`hole` before any body is an error. Only one body per file.
- `polar_pattern` axis must be a world X, Y or Z axis through the origin (maps to a Fusion origin construction axis). Other axes are rejected. A pattern of a pattern is rejected. For angles below 360 the angle is the span from first to last occurrence (UNVERIFIED that Fusion agrees).
- Level 1 builds with the evaluated `value`. The Reify `expr` is kept in the plan (`extent.expr`) for a later level that maps it to Fusion user parameters.
- Distances are passed with `ValueInput.createByReal` in cm (the API unit), not as strings, to avoid locale decimal separator problems.
- Sketch plane: base origin plane when the offset is 0, else a construction plane by offset. The offset sign and extrude direction are measured against the real Fusion plane normal at run time (the sketch point mapping uses `sketch.modelToSketchSpace`), so a flipped Fusion normal is handled.
- Reify is Z-up. The add-in forces `defaultModelingOrientation = ZUp` while creating the document and restores the preference afterwards.

## Unsaved and cloud documents (read this)

- `app.documents.add(FusionDesignDocumentType)` creates a NEW, UNSAVED document in memory. It is not on the cloud until someone saves it (Save asks for a project and name). The add-in never calls `save` or `saveAs`.
- `doc.close(False)` closes the document and discards it; `False` means "do not save". The add-in does this in a `finally` block after the exports, also when the job fails.
- `design.exportManager` (`createFusionArchiveExportOptions`, `createSTEPExportOptions`, `execute`) writes to the local path we pass and does not upload anything.
- Side effects: the new document becomes the active document, so the user sees a tab appear and disappear while a job runs. The user's own open documents are not modified or closed.

UNVERIFIED - check on a real install (each becomes a PR risk):

1. `doc.close(False)` on a never-saved document closes without a prompt, and nothing appears in the cloud project list or the "Recent" list afterwards.
2. `documents.add` does not trigger a "save to project" dialog or a cloud autosave for a new document (for example when the user has autosave or "save on close" prompts enabled).
3. `Application.preferences.generalPreferences.defaultModelingOrientation` exists, applies to `documents.add`, and the exported STEP is Z-up. If it does not apply, the equivalence check will report a rotated bounding box.
4. `design.designType = ParametricDesignType` can be set on a fresh document without a dialog. `design.fusionUnitsManager.distanceDisplayUnits` exists (only affects display; failure is logged as a warning).
5. `ProfileCurve.geometry` is in sketch space. (If not, the code retries as model space and logs `WARN`.) `geometry.evaluator.getParameterExtents/getPointAtParameter` work on all profile curve kinds.
6. Timeline/sketch/plane `name` accepts `/` (otherwise the code falls back to `_` and logs a warning; the Reify semantic name is then not preserved in Fusion).
7. `ExtentDirections` lives in `adsk.fusion`; `setOneSideExtent`, `setSymmetricExtent(distance, isFullLength=True)` (total length), `setAllExtent(SymmetricExtentDirection)`.
8. `CircularPatternFeatureInput` accepts `ValueInput.createByReal` for `quantity` and `totalAngle` (radians), and the pattern of a cut feature recomputes correctly.
9. `physicalProperties.volume` is cm^3 and the sum over `rootComponent.bRepBodies` is the solid volume after each feature.
10. `app.currentUser` / `app.isOffline` give a usable `signedIn`. These are read on the main thread only.
11. `app.fireCustomEvent` from a non-main thread is safe (documented as thread safe) and `registerCustomEvent` after an unclean shutdown needs the `unregisterCustomEvent` we do first.
12. The add-in runs on Fusion's bundled Python; only the standard library is used.
13. A custom-event handler that runs for a long time (a minute or more) does not make Fusion show "not responding" or kill the add-in.
14. Through-all cut with `setAllExtent` cuts all material on the chosen side only (sketch plane is the top face in the sample).

## Tests

`python3 -m unittest discover -s tests/fusion_addin -v` (plain `unittest`, no Fusion).
`tests/fusion_addin/fake_adsk.py` is a stub of the used `adsk.core` / `adsk.fusion` surface. It catches typos, call order, unit conversion and sign handling. It cannot prove that the real API has these members or behaves the same (see its docstring).
