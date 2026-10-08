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

## Supported features

| Reify feature | Fusion | SolidWorks |
|---|---|---|
| `pad` (length, `midplane`, `reversed`, `up_to_face` on a planar face) | yes | yes |
| `pocket` (length or `through_all`) | yes | yes |
| `hole`: through, blind, counterbore, countersink, drill point | yes (native hole) | yes (Hole Wizard) |
| `hole`: cosmetic thread | no (a warning is written; the diameter stays) | yes |
| `fillet`, `chamfer` (constant size, edges found by geometry) | yes | yes |
| `polar_pattern`, `linear_pattern` (axis along X, Y or Z) | yes | yes |
| `mirror` (origin plane or offset plane) | yes | base or offset plane |
| Sketch geometry: line, arc, circle | yes | yes |
| Sketch plane: XY, XZ, YZ plus offset, Body placement; sketches on planar faces | yes | yes |
| Sketch dimensions (level 1: values) | yes | yes |
| Reify parameters (level 2: user parameters / equations) | yes | yes |
| Density | yes (warning if the API cannot set it) | mass override only (always a warning) |
| Assemblies: part positions only | yes (one `.f3d`) | yes (`.SLDASM` plus part files) |
| Island inside a loop (nesting depth 2 or more) | yes (even-odd rule) | **no** |

In an assembly, a part can come in through `link` or through `import_step` of a STEP that Reify wrote from a project part. Reify records the source `.FCStd` and its hash in `<step>.source.json` when it writes the STEP. If the part changed since (`stale_step`), or the STEP has no record (`unknown_step_source`, for example a bought-in STEP), the export stops and names the unit. Use `link` for project parts.

When an expression is outside the supported grammar (numbers, parameter names, `+ - * /`, parentheses, `mm`, `deg`), the executor uses the value and writes an entry in `result.json` `warnings`. It never skips a feature.

Everything else stops the export with `TRANSFER_UNSUPPORTED_OP`, and the error names the feature: modeled threads, taper, midplane pockets, pad `up_to_last`/`two_lengths`, variable fillets, non-planar faces, bought-in STEP units in an assembly, joints and mates. Reify never skips a feature silently. The canonicalizer deviations are in [protocol.md](protocol.md) section 8.

## Known limits

- The two executors have not run against a real Fusion or SolidWorks yet. Both READMEs list every API assumption that needs a real install: [Fusion](../../executors/fusion/README.md), [SolidWorks](../../executors/solidworks/README.md). The SolidWorks executor has not been compiled.
- A dimension change in Fusion or SolidWorks changes that file only. It does not change the Reify parameter. Parameters that Reify exports become user parameters (Fusion) or equations (SolidWorks), so one change there rebuilds all features that use it.
- The highest-risk unverified parts are the assembly code (both targets) and the SolidWorks Hole Wizard call. Its constants are placeholders. Record a macro in SolidWorks and replace them.
- Fusion shows the new document tab during a job. The add-in closes the document without a cloud save (`close(False)`). Check on a real install that nothing reaches the cloud project.
- The Fusion and SolidWorks API versions that were tested are not pinned yet. Record them after the manual checks.
- SolidWorks runs only on the customer's licensed copy.
- The C# executor needs a code signature, or Windows SmartScreen warns the user. The signing step is a hook in `apps/desktop/scripts/package-windows.mjs`. It does nothing until the signing variables are set.

## Manual checks before the issue closes

Record each result in the PR.

1. Export `body_shell`, `axle`, `roller_screw` and the reference plate to Fusion (and to SolidWorks), once from the UI and once from the agent. The equivalence check must pass.
2. The feature tree shows named features in the same order as Reify.
3. Change one dimension in Fusion or SolidWorks. The model must rebuild.
4. **WSL:** run one export from a project in WSL (`/mnt/c/Users/...` paths). The job folder crosses the Windows/WSL boundary, so check that the native file and the verification STEP come back into the project.
5. An assembly of project parts: export once with `link` and once with `import_step` of the part STEPs (the second must work only while the STEPs are current).
6. Record the Fusion and SolidWorks versions that were tested, and whether Fusion left anything in the cloud project.

## Phases

P0 and P1 (parts, through holes, polar patterns) and P2/P3 (the table above) are written. Nothing in the executors has run against a real Fusion or SolidWorks. Treat P2 and P3 as unverified until the manual checks in the issue pass.
