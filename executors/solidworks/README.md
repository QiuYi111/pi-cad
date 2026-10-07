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
- Hole: plain through-all cut of the circles of its sketch (diameter field is not cross-checked).
- Polar pattern: reference axis from two base planes (`InsertAxis2`), then `FeatureCircularPattern5`, equal spacing for a full
  circle; partial angle uses spacing = angle / (n-1).
- After every feature the volume is read and written to `feature_volumes` (mm3).
- Semantic names are applied to sketches and features (`Feature.Name`), e.g. `bracket/base`.

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
15. Not handled: the exported STEP is whatever SolidWorks writes; the equivalence check is done by the desktop with cadctl.
