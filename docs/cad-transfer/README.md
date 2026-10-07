# cad.transfer: Fusion and SolidWorks files with feature history

`cad.transfer` sends a Reify part (a FreeCAD `.FCStd` document) to Autodesk Fusion (`.f3d`) or SolidWorks (`.SLDPRT`). The CAD program builds the part again, feature by feature. The file has a feature tree with the Reify feature names. The user can change a dimension in Fusion or SolidWorks and the model rebuilds.

The CAD program runs on the user's own computer. The Reify desktop app starts it. Reify never runs Fusion or SolidWorks on a server.

The wire formats are in [protocol.md](protocol.md).

## Setup

The text below is the same text as Settings > CAD exports in the desktop app.

### Autodesk Fusion

1. Install Autodesk Fusion on this computer.
2. Click **Install add-in**. Reify copies the ReifyExport add-in into Fusion.
3. Start Fusion. If Fusion is open, close it and start it again.
4. In Fusion, open Utilities, then Add-Ins. On the Add-Ins tab, select ReifyExport. Click Run. Turn on Run on Startup.
5. Sign in to Fusion. Then click **Test export**.

Keep Fusion open while you export. The card shows "Add-in running" when the add-in writes its heartbeat. It shows "Add-in not running" when the heartbeat is older than 15 seconds.

Add-in folder:

- Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\ReifyExport`
- macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/ReifyExport`

### SolidWorks (Windows only)

1. Install SolidWorks 2022 or a newer version. SolidWorks must run on Windows.
2. Start SolidWorks one time. Wait until SolidWorks is fully open. Then you can close it.
3. Click **Test export**. Reify starts the ReifyExport program that comes with Reify.

SolidWorks must be activated (licensed). The first export starts SolidWorks if it is closed. Close modal dialogs in SolidWorks before you export, because a modal dialog blocks the export program. The minimum version, 2022, is a proposal. It has not been tested.

The SolidWorks section is hidden on macOS and Linux. In a WSL setup, Reify copies the project files to Windows and back. You do not change any path.

### Test export

**Test export** builds a reference plate (40 x 30 x 5 mm, 4 through holes, 1 pocket), exports it, runs the equivalence check and shows pass or fail and the log path.

## API

```python
import cad

await cad.transfer.status()
# TransferStatus(fusion='ready', solidworks='not_installed')

features = await cad.transfer.features("parts/bracket.FCStd")   # dry run, no CAD program needed
# TransferFeatures(part='bracket', features=7, path='build/transfer/bracket.features.json')

job = await cad.transfer.export("parts/bracket.FCStd", target="fusion", output="exports/bracket.f3d")
result = await job.result()
# TransferResult(target='fusion', file='exports/bracket.f3d', check='passed', features=7)
```

- `doc` is a `.FCStd` path or a `PartDocument`. The tool reads the committed, recomputed document. It never changes it.
- `output` defaults to `exports/<stem>.f3d` or `exports/<stem>.SLDPRT`.
- `check=False` is for debugging. The result then has `check='skipped'`.
- `TransferResult` fields: `target`, `file`, `check_step`, `check`, `features`, `log`, `detail`. A result can be stored in a commit.

| Error code | Meaning |
|---|---|
| `TRANSFER_TARGET_NOT_READY` | The target is not set up. The hint points to Settings > CAD exports. |
| `TRANSFER_UNSUPPORTED_OP` | A feature is outside the supported set. `target` is the semantic path of the feature. |
| `TRANSFER_EXECUTOR_FAILED` | Fusion or SolidWorks could not build a feature. `target` names it. |
| `TRANSFER_CHECK_FAILED` | The exported shape differs. `target` is the first feature that differs. The files are kept for debugging. |
| `TRANSFER_TIMEOUT` | The CAD program did not finish in time. |
| `TRANSFER_UNAVAILABLE` | The Reify desktop app is not running for this project. |

Sidecar operations: `transfer-status`, `transfer-features`, `transfer-export`. In desktop read-only mode, `transfer-export` is denied. The dry run is allowed.

## How it works

1. `export_features` runs in the FreeCAD worker on the recomputed document. It writes canonical feature JSON (`reify.features/1`). It does not replay `ops.jsonl`.
2. The sidecar writes a request in `.pi-cad/transfer/requests/`. The desktop app picks it up. The UI button uses the same code.
3. The desktop app starts the executor: it writes a job file for the Fusion add-in, or starts `ReifyExport.exe` for SolidWorks. One job runs at a time for each executor.
4. The executor builds the part, writes the native file and a verification STEP, and copies the result back into the project.
5. The sidecar compares the verification STEP with the Reify STEP: relative volume error at most 1e-6, equal bounding boxes (1e-6 of the part size), and face fingerprints that match one to one.

The coordinate system stays Z up. A Y-up option is a later change. If it is added, it must also apply to STEP and assemblies.

## Supported features (P0 and P1)

| Reify feature | Fusion | SolidWorks |
|---|---|---|
| `pad` (length, `midplane`, `reversed`) | yes | yes |
| `pocket` (length or `through_all`) | yes | yes |
| `hole` (`through_all`, plain) | yes, as a cut-extrude of circles | yes, as a cut-extrude of circles |
| `polar_pattern` (axis along X, Y or Z through the origin) | yes | yes |
| Sketch geometry: line, arc, circle | yes | yes |
| Sketch plane: XY, XZ, YZ plus offset, Body placement | yes | yes |
| Island inside a pocket loop (nesting depth 2 or more) | yes (even-odd rule) | **no** |

Everything else stops the export with `TRANSFER_UNSUPPORTED_OP`, and the error names the feature: `fillet`, `chamfer`, `linear_pattern`, `mirror`, blind, counterbore, countersink and threaded holes, `up_to_face`, sketches attached to a face, tilted sketch planes, assemblies, suppressed features. Reify never skips a feature silently.

## Known limits

- The two executors have not run against a real Fusion or SolidWorks yet. Both READMEs list every API assumption that needs a real install: [Fusion](../../executors/fusion/README.md), [SolidWorks](../../executors/solidworks/README.md). The SolidWorks executor has not been compiled.
- Level-1 only: dimensions are values. The JSON carries the Reify expression (`expr`), but the executors do not use it yet. A dimension change in Fusion or SolidWorks changes the feature, not the Reify parameter.
- Fusion shows the new document tab during a job. The add-in closes the document without a cloud save (`close(False)`). Check on a real install that nothing reaches the cloud project.
- The Fusion and SolidWorks API versions that were tested are not pinned yet. Record them after the manual checks.
- SolidWorks runs only on the customer's licensed copy.
- The C# executor needs a code signature, or Windows SmartScreen warns the user. The signing step is a hook in `apps/desktop/scripts/package-windows.mjs`. It does nothing until the signing variables are set.

## Later phases

- **P2:** level-1 sketch constraints, density to material, assemblies (part positions only), `linear_pattern`, `mirror`.
- **P3:** level-2 parameters (expressions as user parameters or equations), blind/counterbore/countersink/threaded holes, fillet and chamfer (edge references), sketches on faces, `up_to_face`.
