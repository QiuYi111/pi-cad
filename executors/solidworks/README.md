# ReifyExport (SolidWorks executor)

`ReifyExport.exe` is a small .NET console program. The Reify desktop app starts it once per job. It reads the job folder
`<jobRoot>\solidworks\jobs\<jobId>\job.json` (protocol: `docs/cad-transfer/protocol.md`, sections 1 and 2), builds a native
SolidWorks part with feature history through the SolidWorks COM API, and writes into the same folder:
`part.SLDPRT`, `check.step`, `result.json`, `log.txt`.

```
ReifyExport.exe --version        prints: ReifyExport 0.1.0
ReifyExport.exe --check          prints: {"version":"0.1.0","swInstalled":true,"swVersion":"2023"}
ReifyExport.exe --job <dir>      runs one job; exit code 0 = ok, 1 = failed (result.json says why), 2 = bad arguments
```

## Status: NOT COMPILED, NOT RUN

The environment this was written in has no `dotnet` SDK and no SolidWorks (the SDK download host was blocked by the proxy).
Nothing here was compiled, no test was run, and no call was made against SolidWorks. The code was written carefully from
knowledge of the public SolidWorks API. Treat the first build on a Windows machine as the first compile, and the first
job as the first test of every API call listed under UNVERIFIED below.

## Layout

| Project | Target | Content |
| --- | --- | --- |
| `ReifyExport.Core` | net8.0, no Windows/SW dependency | JSON models, planner (validation, unit and plane math), `JobRunner`, `result.json` writer, log, CLI parsing, `--check` logic behind `ISwProbe`, watchdog |
| `ReifyExport` | net8.0-windows, x64 | `Program` (mutex, watchdog, COM STA thread), `SwPartBuilder` (all SolidWorks calls), `RegistrySwProbe`, `ComHelper` |
| `ReifyExport.Core.Tests` | net8.0, xunit | parsing of a sample canonical file, plan order, mm to m, direction logic, error mapping, runner with a fake builder, `result.json` shape, `--check` with a fake probe |

All sequencing and error handling is in `Core.JobRunner` and talks to SolidWorks only through `IPartBuilder`, so it is tested without SolidWorks.

## Build

Tests (any OS):

```
dotnet test executors/solidworks/ReifyExport.Core.Tests
```

Executor (Windows, SolidWorks installed, or the two interop DLLs copied somewhere):

```
dotnet publish executors/solidworks/ReifyExport -c Release -r win-x64 --self-contained false
# interop DLLs not in the default location:
dotnet publish executors/solidworks/ReifyExport -c Release -r win-x64 --self-contained false /p:SwApiDir="D:\sw\api\redist"
```

The project references `SolidWorks.Interop.sldworks.dll` and `SolidWorks.Interop.swconst.dll` by HintPath
(`C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist` by default, override with `/p:SwApiDir`). They are not in the repo.
The packaging step supplies them; `Private=true` copies them next to the exe. Requires the .NET 8 Desktop/Runtime on the
customer machine (framework-dependent publish) or switch to `--self-contained true` in packaging.

## Signing

Sign `ReifyExport.exe` (and the interop DLLs if the packaging policy requires it) in the desktop packaging step, with the same
Authenticode certificate as the desktop app:
`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 /a ReifyExport.exe`.
An unsigned exe started from `%LOCALAPPDATA%` can trigger SmartScreen ("Windows protected your PC") or be blocked by AV or
AppLocker. SmartScreen reputation builds per certificate, so use the app's certificate rather than a new one.

## Minimum SolidWorks version: proposal 2022

Proposal only, not a tested bound. Reasons: the calls used (`FeatureExtrusion3`, `FeatureCut4`, `FeatureCircularPattern5`,
`ModelDocExtension.SaveAs3`, `InsertAxis2`) are all older than 2022, but the author could not run any version, so 2022 is a
recent, still widely deployed release that the lead can confirm or move after the first real run. `--check` reports the newest
installed year it finds, so the app can gate on it.

## How the plan works

- Planning happens completely before SolidWorks is touched. Anything unsupported stops the job with `result.json`
  `ok:false`, `error.code: "UNSUPPORTED_OP"`, `error.feature` = the feature (never skipped silently): unknown feature type,
  unknown sketch geometry (only line, arc, circle, polyline), open loops, loop depth >= 2, oblique extrusions, extents other than
  length / through_all, multiple bodies, polar pattern axes not parallel to a world axis or not through the origin.
- Units: JSON mm / degrees. The SolidWorks API takes meters / radians / m3 regardless of document units. All conversion is in
  `Units`. The document is also set to mm. Reported volumes are mm3.
- Coordinates: Z-up world coordinates are used unchanged as SolidWorks model coordinates (no rotation). Mapping (UNVERIFIED):
  `XY` -> Front plane (SW normal +Z), `XZ` -> Top plane (normal +Y), `YZ` -> Right plane (normal +X). Base planes are the first three
  `RefPlane` features of the new part by type order (Front, Top, Right in the default template).
- Offset planes: a frame origin off the base plane creates a distance reference plane; offset = dot(frame.origin, SW plane
  normal).
- Sketch points: world point (m) -> `Sketch.ModelToSketchTransform` -> sketch (x,y). The transform is authoritative. Checks:
  the transformed point must lie on the sketch plane (|w| < 1e-7 m) else `EXECUTOR_FAILED` (wrong plane order or offset sign);
  a predicted mapping (`SketchMath.ExpectedSketchCoords`) is compared and only logs a warning. Arc direction is derived from
  the sketch-space images of the canonical U and V axes, so a mirrored sketch frame still gives the same arc.
- Nested contours: all geometry of a canonical sketch is drawn into one SolidWorks sketch, the sketch feature is pre-selected
  and the extrude/cut is called. SolidWorks builds the regions from the contours. A depth-0 loop with depth-1 loops inside (plate
  with holes, pocket ring) matches the protocol's even-odd rule. Depth >= 2 (island inside a hole) is rejected with
  `UNSUPPORTED_OP`: a pocket with an island is a known limit.
- Directions: pad default = +sketch normal, cut default = -normal (UNVERIFIED, one constant: `PlanConventions.CutDefaultsToMinusNormal`).
  `Dir` (reverse) is set when the canonical `direction` differs from that default. `midplane` -> `swEndCondMidPlane`.
  `through_all` -> `swEndCondThroughAll`. A pad that adds no volume, or a cut that removes none, fails the job with a clear message,
  which also catches a wrong direction convention.
- Hole: see P3 below (Hole Wizard, with a cut-extrude fallback for plain holes).
- Polar pattern: reference axis from two base planes (`InsertAxis2`), then `FeatureCircularPattern5`, equal spacing for a full
  circle; partial angle uses spacing = angle / (n-1).
- After every feature the volume is read and written to `feature_volumes` (mm3).
- Semantic names are applied to sketches and features (`Feature.Name`), e.g. `bracket/base`.

## P2 and P3 additions (protocol sections 6 and 7)

All planning stays in `ReifyExport.Core` (`Planner`, `ExprParser`, `EdgeMatch`, `FaceMatch`, `AssemblyPlanner`, `TransformMath`), so everything except the actual SolidWorks calls is covered by xunit tests with a fake `IPartBuilder`.

- `linear_pattern`: `FeatureLinearPattern5`, direction = the reference axis of the world axis (axis-parallel directions only; `reversed` -> reverse flag). Spacing is checked against `length/(occurrences-1)`.
- `mirror`: `InsertMirrorFeature2`. Normal must be axis-parallel. The base plane is used when the plane passes through the origin, otherwise a distance reference plane is created. Tilted mirror planes are `UNSUPPORTED_OP`.
- Sketch `dimensions`: added after the geometry is drawn (AddToDB off) with `AddDimension2` / `AddHorizontalDimension2` / `AddVerticalDimension2` on selected segments or points. The measured value is compared with the canonical value (circle = diameter, arc = radius in SolidWorks) and never overwritten. Failure -> `EXECUTOR_FAILED`, step `sketch_dimension`, message names the sketch and the dimension. `distance_x`/`distance_y` need an axis-aligned sketch and are `UNSUPPORTED_OP` on tilted-face sketches. Polyline geometry cannot be dimensioned.
- Material: `material.density_kg_m3` is applied as a mass override (`MassProperty.OverrideMass = density x volume`). The SolidWorks material is NOT set. A warning is always added to `result.json warnings` saying so (setting `MaterialPropertyValues` by index was judged too risky without a real SolidWorks).
- Assemblies (`job.kind == "assembly"`): each part is built and saved as `<part name>.SLDPRT` in the job dir, then closed. A new assembly (default assembly template) is created and each part inserted with `AddComponent5`, then `Component2.Transform2` is set from a `MathTransform` built with `MathUtility.CreateTransform` (`TransformMath.ToSwArray`: 9 rotation values, translation in meters, scale, padding). The assembly is saved as `output.native` (`part.SLDASM`), the whole assembly goes to `check.step`. `files.extra` lists the per-part `.SLDPRT` names. `feature_volumes` has one entry per occurrence (the final volume of its part; a rigid placement does not change it). `features_built` counts features over all parts.
- Parameters: `parameters[]` become global variables (`"name" = 40mm`) through `EquationMgr.Add3`. A scalar with an expression in the protocol grammar (numbers, names, + - * /, parentheses, mm, deg) whose evaluated value equals the exported value is bound with an equation `"D1@<feature>" = ("width" / 2)`. Bound today: pad/pocket depth, fillet radius, chamfer size, linear pattern spacing, sketch dimension values. Everything else with an `expr` (hole dimensions, counterbore ...) keeps its value and gets a `warnings` entry. Any expression problem (outside the grammar, unknown name, value mismatch, bind failure in SolidWorks) is a warning, never a skipped feature.
- Hole: `HoleWizard5` on a position sketch made of points (blind/through, counterbore, countersink, drill point flat/angled, cosmetic thread -> Tap type). The Hole Wizard constants and the Value1..12 slot meaning are PLACEHOLDERS (class `Hw` in `SwPartBuilder.cs`): record a Hole Wizard macro on the target version and copy the numbers. If the call returns null and the hole is plain (no counterbore, countersink, thread or drill point) it falls back to circles + cut and adds a warning; otherwise the job fails.
- Fillet and chamfer: `EdgeMatch.Resolve` (curve type, midpoint, length; circles by centre and radius, because the seam differs between kernels) on the edges of the body BEFORE the feature, tolerance 1e-4 x part diagonal (diagonal from the body box). Zero or several matches -> `EXECUTOR_FAILED`, step `edge_match`, names the feature. The matched `Edge` is selected with `Entity.Select4`; fallback `SelectByID2("", "EDGE", point)` using the edge midpoint. `SelectByRay` is NOT used (deviation from the brief, because the entity handle is already known from the body traversal).
- Face references: `FaceMatch.Resolve` (planar, plane contains the point, normal parallel either sign, area within 1e-4 relative). Used for tilted-face sketches (sketch on the selected face; direction logic uses the face normal) and `up_to_face` (end condition `swEndCondUpToSurface` with the face selected with mark 1).
- Nesting depth 2 (island inside a hole) is still rejected with `UNSUPPORTED_OP`: it cannot be done with confidence without running SolidWorks.

### Final unsupported list (all reported as `UNSUPPORTED_OP` naming the feature, before SolidWorks is touched)

Feature types other than pad, pocket, hole, polar_pattern, linear_pattern, mirror, fillet, chamfer; sketch geometry other than line, arc, circle, polyline; open loops; loop depth >= 2; oblique extrusions; pad extents other than length / up_to_face, pocket extents other than length / through_all; midplane together with through_all / up_to_face / holes; more than one body; polar pattern axes not parallel to a world axis or not through the origin; linear pattern directions not axis-parallel; tilted mirror planes; modeled threads; counterbore together with countersink; hole sketches with anything but equal-diameter circles, or sharing a sketch with another feature; edge_ref curves other than line, circle, arc; sketch dimension kinds other than distance, distance_x, distance_y, radius, diameter, angle; `distance_x/y` on a tilted-face sketch; dimensions on polylines. Planning errors that are not unsupported constructs (bad schema, duplicate names, unknown sketch, bad refs, inconsistent pattern spacing, bad assembly transforms) are `EXECUTOR_FAILED` with step `plan`.

## Runtime behaviour and COM caveats

- Licensing: the exe drives the customer's own licensed SolidWorks. It cannot run without it. Nothing is redistributed except
  the interop DLLs from the `redist` folder.
- First export starts SolidWorks (slow, often 30 to 90 s, part of `timeoutS`). A running instance is reused. The executor never
  quits SolidWorks.
- Jobs are serialized with the named mutex `Global\ReifyExport.SolidWorks` (waits up to min(timeoutS, 60) s, then
  `error.code: "BUSY"`).
- Timeout: a watchdog starts after the lock is taken. On expiry it writes `result.json` `ok:false`,
  `EXECUTOR_FAILED`, message `timeout after N s` (with the current feature and step) and exits with code 1.
- Modal dialogs: SolidWorks blocks every COM call while a modal dialog is open (rebuild error, missing template, license
  prompt). The worker thread then hangs and only the watchdog ends the job. The executor sets `UserControl = false` and uses
  `CloseDoc` and silent save options to avoid prompts, but it cannot dismiss a dialog. After a timeout the document may stay open in SolidWorks and the user may have to
  close the dialog by hand.
- The executor runs on an STA thread (`[STAThread]`).
- `Marshal.GetActiveObject` does not exist on .NET 8, so `ComHelper` calls the OLE `GetActiveObject` directly.

## UNVERIFIED API usage (for the PR description)

Everything below was written without running SolidWorks or compiling.

1. SolidWorks classic interop assemblies (built for .NET Framework) loading and casting under net8.0-windows (expect NU1701 warnings).
2. Plane mapping XY/XZ/YZ -> Front/Top/Right, and that the first three `RefPlane` features are Front, Top, Right (also for customer templates).
3. `Sketch.ModelToSketchTransform` + `MathUtility.CreatePoint(double[])` + `MathPoint.MultiplyTransform` + `ArrayData` as written; predicted sketch axes (Front (x,y), Top (x,-z), Right (-z,y)).
4. `SketchManager.AddToDB` while drawing, `CreateLine`, `CreateCircleByRadius`, `CreateArc(..., short direction)` argument order and direction sign.
5. `model.FeatureByPositionReverse(0)` returns the sketch / axis feature just created (type names `ProfileFeature`, `RefAxis`).
6. `Feature.Name` accepts names containing `/`.
7. `FeatureManager.InsertRefPlane` argument meaning and the sign of the distance for offset sketch planes.
8. `FeatureExtrusion3` (23 args) and `FeatureCut4` (27 args) parameter order; meaning of `Dir` for cuts; default cut direction (-normal); `D1` = total depth for mid-plane; through-all with `Dir`; nested contours with the whole sketch pre-selected (`Select2(false, 0)`).
9. `ModelDoc2.InsertAxis2(true)` creating an axis from two selected planes; selection marks 1 (axis) and 4 (features) for `FeatureCircularPattern5` (14 args); equal-spacing semantics; partial-angle spacing.
10. `ModelDocExtension.CreateMassProperty()`, `MassProperty.UseSystemUnits`, `.Volume` in m3.
11. `ModelDocExtension.SaveAs3` signature with null `ExportData` / `AdvancedSaveAsOptions`; STEP export by file extension; `swUserPreferenceIntegerValue_e.swStepAP` = 214.
12. `ModelDocExtension.SetUserPreferenceInteger(swUnitsLinear, 0, swMM)`; `swApp.UserControl = false`; `swApp.Visible = true`; `NewDocument` with the default template string; `RevisionNumber()` format for the app string.
13. Registry layout for `--check`: `HKLM\SOFTWARE\SolidWorks\SOLIDWORKS <year>` sub keys and `HKCR\SldWorks.Application\CLSID`.
14. `CloseDoc(title)` using `GetTitle()` after save (title may carry the `.SLDPRT` extension).
15. (P2/P3) `FeatureLinearPattern5` argument list and direction handling (reference axis with unknown sign); `InsertMirrorFeature2(BMirrorBody, BGeometryPattern, BMerge, BKnit, ScopeOptions)` and selection marks 1 (features) and 2 (plane).
16. (P2) Sketch dimensions: `ModelDoc2.AddDimension2/AddHorizontalDimension2/AddVerticalDimension2` placement coordinates (sketch space), `DisplayDimension.GetDimension2(0)`, `Dimension.Name` setter, `Dimension.SystemValue` in SI, `SketchSegment/SketchPoint.Select4`, `SketchLine/SketchArc.GetStartPoint2/GetEndPoint2/GetCenterPoint2`, origin selection `SelectByID2("Point1@Origin","EXTSKETCHPOINT")`; circle dimensioned as diameter, arc as radius.
17. (P2) `MassProperty.OverrideMass` as the density mechanism and that it persists in the saved file.
18. (P2) Assemblies: `swDefaultTemplateAssembly`, `OpenDoc6` silent open before `AddComponent5`, `AddComponent5` arguments, `MathUtility.CreateTransform(double[16])` data layout (rotation row order, translation at 9..11, scale at 12), `Component2.Transform2` setter, `ActivateDoc3`, STEP export of an assembly through `SaveAs3`, closing the opened part docs after the assembly.
19. (P3) `EquationMgr.Add3(-1, equation, true, swAllConfiguration, null)`, global variable syntax with `mm`/`deg` suffix, dimension full names `D1@<feature>` for extrude depth, fillet radius, chamfer size and pattern spacing (the default dimension name `D1` is a guess), and that names containing `/` work in equations.
20. (P3) `HoleWizard5` (27 arguments, all constants and the Value1..12 slot use are placeholders), selection of a point sketch for it, cosmetic thread through Tap type.
21. (P3) `FeatureFillet3` (14-argument recorded form with Options 195) and `InsertFeatureChamfer(0, 4 = equal distance, size, ...)`.
22. (P3) Body queries: `PartDoc.GetBodies2`, `Body2.GetBodyBox/GetEdges/GetFaces`, `Edge.GetCurve`, `Curve.GetEndParams/Evaluate2/GetLength3/IsLine/IsCircle/CircleParams`, `Face2.GetSurface/Normal/GetArea` (m2), `Surface.PlaneParams` layout `[nx,ny,nz,px,py,pz]`, `Entity.Select4` on edges and faces, `SelectionMgr.CreateSelectData().Mark`.
23. (P3) Sketch on a selected planar face: the sketch normal equals the face's outward normal (the reverse flag logic relies on it), and `swEndCondUpToSurface` with a mark-1 face for a boss.
24. Not handled: the exported STEP is whatever SolidWorks writes; the equivalence check is done by the desktop with cadctl.
