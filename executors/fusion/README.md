# ReifyExport: Autodesk Fusion add-in

Executes Reify canonical feature JSON (`reify.features/1`) in Fusion and exports `.f3d` plus a STEP file for the equivalence check. The wire contract is `docs/cad-transfer/protocol.md` (sections 1 and 2). Version 0.2.0 (P0 to P3).

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

Pure Python, no `adsk` import, unit tested with `python3 -m unittest discover -s tests/transfer/fast/fusion_addin -v`:
`jobroot.py`, `jobs.py` (claim, validate, result, error mapping), `plan.py`, `profiles.py` (even-odd), `geom.py`, `workers.py` (watcher and heartbeat threads).
Thin Fusion layer: `fusion_exec.py` (all `adsk` calls), `ReifyExport.py` (run/stop, custom events).

Threading: the watcher thread only calls `app.fireCustomEvent`. The event handler runs on the Fusion main thread and does all API calls. The heartbeat thread uses a cached snapshot (refreshed by a tick event and after each job), so the heartbeat stays fresh while a long job blocks the main thread.

## What it builds (0.2.0)

Each group sits behind a flag of `plan.build_plan(enable_p1, enable_p2, enable_p3, native_holes, bind_params)` so it can be switched off.

- P0: `pad` (length, midplane), `pocket` (length or through_all).
- P1: extrude-cut `hole` of circles (used when `native_holes=False`), `polar_pattern` (CircularPatternFeature, origin axis X/Y/Z through the origin only).
- P2: `linear_pattern` (RectangularPatternFeature, one direction along a world axis, spacing mode), `mirror` (MirrorFeature; plane must be parallel to XY/XZ/YZ: origin plane when through the origin, else an offset construction plane; tilted planes are `UNSUPPORTED_OP` naming the feature), sketch `dimensions`, top-level `material.density_kg_m3`, assembly jobs.
- P3: user parameters, native `holeFeatures` (through/blind, counterbore, countersink, drill point flat/angled), `fillet`, `chamfer` (edges resolved by `edgematch.py`), `face_ref` (`facematch.py`) for sketches on tilted faces and for `pad` `up_to_face`.
- Sketch geometry: line, arc, circle, polyline. Each profile region is chosen with the even-odd rule (see `profiles.py`); profiles are never selected blindly.
- Anything else raises `UNSUPPORTED_OP` naming the feature (and the option) in the plan, before Fusion is touched. Nothing is skipped silently.

Behaviour worth knowing:

- **Parameters (level 2).** `parameters[]` become `design.userParameters`. A scalar `expr` is bound (as a Fusion expression string) only when it passes `params.py`: grammar of protocol section 7, known names, the expected unit dimension (length or angle), and it evaluates to the scalar's `value` (1e-6). A bare number next to a quantity adopts its unit (`=hole_d + 2` becomes `hole_d + 2 mm`). Anything else uses the value and adds `{feature, field, expr, reason}` to `result.json` `warnings`. If Fusion rejects an accepted expression at feature creation, the feature is rebuilt from the value and a warning `field: "expression"` is added. The feature is never skipped. Parameters are design-global, so assembly jobs do not create them (one warning per part).
- **Warnings.** `result.json` always has `warnings` (a list). Besides expressions it carries: cosmetic thread not created, hole-sketch dimensions not added (the hole sketch is rebuilt from `positions`), a dimension skipped because Fusion's sketch axes are rotated against the canonical u/v (horizontal/vertical is undefined), and a density that could not be applied.
- **Holes.** `native_holes=True` (default) uses `holeFeatures` with sketch points at `positions`. A `thread` is NOT created: a Fusion tapped hole changes the hole diameter, which would break the equivalence check, so the hole keeps its diameter and a warning is added. `thread.modeled: true` is `UNSUPPORTED_OP`.
- **Sketch dimensions.** Added after the geometry is drawn: `distance` (aligned), `distance_x`/`distance_y` (horizontal/vertical), `radius`, `diameter`, `angle`. A dimension that the API rejects fails the job with `EXECUTOR_FAILED`, `step: "dimension"`, and the message names the sketch. If the dimension carries a valid parameter expression, it is bound to the dimension.
- **Edge and face refs.** Edges are matched by curve type, midpoint, length (and radius/centre/axis/start/end when given) with tolerance `1e-4 x max(part diagonal in mm, 1)`. Zero or several matches fail with `step: "edge_ref"` / `"face_ref"` naming the feature. The tolerance reading of "1e-4 mm times the part diagonal" is ours (protocol section 7 is ambiguous).
- **Assemblies.** `job.kind == "assembly"` with `assembly` inline. One new design, one component per occurrence (`addNewComponent(matrix)`, matrix columns are the rotation columns, origin in cm), each built with the part's feature plan. The STEP and the single `part.f3d` contain the whole assembly. `feature_volumes` has one entry per occurrence name. Mirrored (det < 0) transforms are `UNSUPPORTED_OP`. `files.extra` is not produced.
- **Material.** The density is set by copying a library material (`design.materials.addByCopy`), setting `structural_Density` (kg/cm^3) and assigning it to the bodies. If anything fails it is a warning, never a failed job.

Other decisions and limits (from 0.1.0):

- A second `pad` joins the existing body (first pad is a new body). A `pocket`/`hole`/`fillet`/`chamfer` before any body is an error. Only one body per part.
- `polar_pattern` and `linear_pattern` need a world axis; `mirror` accepts patterns as originals, patterns do not. For angles below 360 the angle is the span from first to last occurrence.
- Distances are passed with `ValueInput.createByReal` in cm (the API unit), or `createByString(expression)` when a parameter is bound.
- Sketch plane: base origin plane when the offset is 0, else a construction plane by offset. Offset sign and extrude direction are measured against the real Fusion plane normal at run time (point mapping uses `sketch.modelToSketchSpace`), so a flipped Fusion normal is handled.
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

### New UNVERIFIED items for P2 and P3

15. `features.rectangularPatternFeatures.createInput(entities, axis, quantity, distance, SpacingPatternDistanceType)` accepts an origin construction axis and feature entities; a negative distance reverses the direction.
16. `features.mirrorFeatures.createInput(features, plane)` accepts origin planes and offset `ConstructionPlane`s for feature mirroring.
17. `sketch.sketchDimensions.addDistanceDimension / addRadialDimension / addDiameterDimension / addAngularDimension` signatures (point/entity, text position), `DimensionOrientations` enum names, and that setting `dimension.parameter.expression` to a parameter expression does not move the geometry. Dimensions on a point of a mirrored sketch, and `originPoint` use.
18. `holeFeatures.createSimpleInput / createCounterboreInput / createCountersinkInput`, `setPositionBySketchPoints`, `setAllExtent(direction)`, `setDistanceExtent`, `isDefaultDirection` (assumed: default direction is opposite to the sketch normal), `tipAngle` (assumed: 0 means flat bottom, 118 deg default). Hole depth semantics (to the full diameter shoulder) versus FreeCAD.
19. Cosmetic threads are not created at all (see Holes above). A real implementation needs `HoleFeatureInput` tapped-hole options and a check that the hole diameter is unchanged.
20. `filletFeatures.createInput().addConstantRadiusEdgeSet(edges, radius, isTangentChain=False)` and `chamferFeatures.createInput2().chamferEdgeSets.addEqualDistanceChamferEdgeSet(edges, distance, False)`. If Fusion propagates the fillet along tangent edges anyway, the volume check will show it.
21. `BRepEdge.geometry.objectType` strings (`adsk::core::Line3D`, `Circle3D`, `Arc3D`), `BRepEdge.evaluator.getPointAtParameter` at the parameter midpoint equals the arc-length midpoint, `BRepEdge.length` in cm, `BRepFace.geometry.objectType == "adsk::core::Plane"`, `BRepFace.area` in cm^2, `BRepBody.boundingBox`.
22. `sketches.add(BRepFace)` for a sketch on a tilted face, and that `modelToSketchSpace` on it maps as assumed. `ExtrudeFeatureInput.setOneSideToExtent(face, matchShape, offsetDistance, directionHint)` signature (we pass `directionHint` by keyword).
23. `design.userParameters.add(name, ValueInput, units, comment)` with `createByReal` in internal units (cm, radians) for `mm`/`deg` and with an expression string; Fusion's reserved names (we reject a short list in `params.RESERVED`); `createByString("thickness - 2 mm")` style expressions evaluate in the units we assume.
24. Material: `app.materialLibraries`, `design.materials.addByCopy`, the property id `structural_Density` and its unit (assumed kg/cm^3), assigning `body.material`.
25. Assemblies: `rootComponent.occurrences.addNewComponent(Matrix3D)` and `Matrix3D.setWithCoordinateSystem(origin, x, y, z)`; whether `sketch.modelToSketchSpace` inside an occurrence's component uses component-local space (assumed) or assembly space; whether features of different components stay independent in one parametric design; the single `.f3d` and the root STEP export contain all occurrences at their transforms.
26. A pattern of a hole feature in a component, and a mirror of a pattern feature, recompute without error.

## Verified in a live Fusion (2705.1.25)

Items 5, 7, 9, 14, 15, 16, 20, 21, 22 (sketch on a tilted face), 23 and 25 held. These did not, and the code now follows what Fusion does:

- Hole direction: a hole's default direction is opposite to the sketch normal, and `PositiveExtentDirection` means that default direction. `isDefaultDirection` follows the same rule (item 18).
- Flat drill point: `tipAngle` 180 deg. 0 is rejected (item 18).
- `ExtrudeFeatureInput` has no `setOneSideToExtent`. Pad up to a face uses `setOneSideExtent(ToEntityExtentDefinition.create(face, False), direction)` (item 22).
- A sketch created on a face can come with auto-projected reference curves. They are deleted, otherwise they become extra profiles.
- `BRepEdge.geometry` can be `None`. Such edges are skipped when matching edge references.
- A negative dimension expression flips the sketch geometry, so it is not bound.
- A rotation rounded to 6 decimals is rejected by `addNewComponent`; the frame is orthonormalized first.
- The midpoint of a full circle is where the kernel's seam is, so circle edge references match on centre, radius and axis.
- The equivalence check places cylinders and cones by axis, not by centroid, for the same reason.
- A part keeps its place in the assembly (an aircraft tail is 800 mm from the origin) and the new document's camera looks at the origin, so the add-in fits the view before it writes the .f3d. Otherwise the file opens on an empty canvas, and `fit` on it does nothing: a body saved without display graphics draws nothing until Fusion generates them. Fitting before the save generates them and stores them in the file (checked by importing the .f3d again: camera on the body, solid drawn).
- Fusion refuses a dimension on geometry it already holds in place (`VCS_SKETCH_OVER_CONSTRAINTS`): the second of two concentric circles, rectangles that line up with each other. The dimension is skipped with a warning; the equivalence check still proves the shape.

Still UNVERIFIED: items 1 to 4, 6, 8, 10 to 13, 17, 19, 24, 26.

How it was run: the "Fusion MCP Addin" `execute_api_script` tool, loading the add-in sources from a copy and calling `jobs.process_job` per fixture. That reproduces a job without restarting the add-in.

## Tests

`python3 -m unittest discover -s tests/transfer/fast/fusion_addin -v` (plain `unittest`, no Fusion).
`tests/transfer/fast/fusion_addin/fake_adsk.py` is a stub of the used `adsk.core` / `adsk.fusion` surface. It catches typos, call order, unit conversion and sign handling. It cannot prove that the real API has these members or behaves the same (see its docstring).
