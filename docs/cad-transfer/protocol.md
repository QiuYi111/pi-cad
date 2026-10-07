# cad.transfer: wire contracts

This file is the contract between the parts of `cad.transfer`. Each part is built and tested on its own. Change this file first, then the code.

```
cad.transfer (Python, Prime) --sidecar op--> src/agent-api/transfer-ops.ts
    |  export-features (FreeCAD worker)  -> canonical feature JSON
    |  spool request  ------------------> desktop main: cad-transfer.ts   (the dispatcher)
    |                                        |  job folder -> Fusion add-in / SolidWorks executor
    |  <-- spool result ----------------- desktop main
    |  equivalence check (cadctl)
    v
  TransferResult
```

The UI button uses the same dispatcher. Only the spool entry differs.

## 1. Canonical feature JSON: `reify.features/1`

Units are mm and degrees. Z is up. Vectors are `[x, y, z]` in world coordinates. Points inside a sketch are `[u, v]` in sketch coordinates (mm).

A **scalar dimension** (length, depth, radius, diameter, angle, offset) is an object `{ "value": 12.5, "expr": "=width/2" }`. `expr` is optional. It is the Reify expression as the user wrote it (`Params.` is removed). Points, frames and counts are plain numbers.

```jsonc
{
  "schema": "reify.features/1",
  "units": "mm",
  "part": "bracket",                          // semantic name of the part
  "source": { "doc": "parts/bracket.FCStd", "sha256": "<hex of the .FCStd>" },
  "bodies": [{
    "name": "bracket",
    "sketches": [{
      "name": "bracket/base_profile",
      "frame": { "origin": [0,0,0], "u": [1,0,0], "v": [0,1,0], "n": [0,0,1] },   // getGlobalPlacement()
      "plane": { "base": "XY", "offset": 0.0 },  // base plane the frame lies on, signed offset along +n_base
      "geometry": [
        { "id": 0, "type": "line",   "start": [0,0], "end": [40,0] },
        { "id": 1, "type": "arc",    "center": [0,0], "radius": 5, "start_angle": 0, "end_angle": 90,
                                      "start": [5,0], "end": [0,5] },               // counter-clockwise, degrees
        { "id": 2, "type": "circle", "center": [10,10], "radius": 3 }
      ],
      "loops": [
        { "id": 0, "geometry": [0,1,3,4], "closed": true, "depth": 0, "area": 1200.0 },
        { "id": 1, "geometry": [2],       "closed": true, "depth": 1, "area": 28.27 }
      ]
    }],
    "features": [
      { "name": "bracket/base", "type": "pad", "sketch": "bracket/base_profile",
        "direction": [0,0,1],                  // world direction of the extrusion (after `reversed`)
        "extent": { "type": "length", "length": { "value": 5 } },
        "midplane": false, "reversed": false },
      { "name": "bracket/pocket", "type": "pocket", "sketch": "...",
        "direction": [0,0,-1], "extent": { "type": "length", "length": { "value": 2 } }, "reversed": false },
      { "name": "bracket/holes", "type": "hole", "sketch": "...",       // P1: through_all, plain only
        "direction": [0,0,-1], "extent": { "type": "through_all" }, "diameter": { "value": 6 } },
      { "name": "bracket/ring", "type": "polar_pattern", "originals": ["bracket/holes"],   // P1
        "axis": { "origin": [0,0,0], "direction": [0,0,1] },
        "angle": { "value": 360 }, "occurrences": 4, "full_circle": true }
    ]
  }],
  "reference": {                                // what FreeCAD built; used by the equivalence check
    "volume_mm3": 5200.0,
    "bbox": { "min": [..], "max": [..] },
    "feature_volumes": [{ "name": "bracket/base", "volume_mm3": 6000.0 }]     // solid volume after each feature
  }
}
```

Rules:

- `bodies[].features` and `bodies[].sketches` are in document order. Executors build features in this order.
- Loop `depth` is the nesting depth: 0 for a loop that no other loop contains, 1 for a loop inside one loop, and so on. A region (a profile) is a loop with **even** depth, minus its direct children (odd depth). Executors select only regions of even depth (even-odd rule).
- `loops[].geometry` lists geometry ids in drawing order. A circle is a loop of one id.
- Intersecting loops, open loops, and loops that touch are errors in the canonicalizer.
- `pad`/`pocket`/`hole` `direction` is the final world direction in which material is added (pad) or removed (pocket, hole). `midplane: true` means the extent is symmetric about the sketch plane.
- `plane.offset` is the signed distance of `frame.origin` from the base plane, measured along the **positive world axis** of that plane (Z for XY, Y for XZ, X for YZ), not along `frame.n`. `frame.n` may point the other way; executors use `frame.n` for the extrusion sign and `plane.offset` only to place the plane.
- `plane.base` is `XY`, `XZ` or `YZ`. The canonicalizer rejects a sketch whose normal is not parallel to a world axis.
- Supported ops, P0 + P1: `pad` (length, midplane, reversed), `pocket` (length or through_all), `hole` (through_all, no thread, no counterbore, no countersink), `polar_pattern`. Sketch geometry: line, arc, circle (and polyline = lines). Everything else stops the export with `UNSUPPORTED_OP`.

Canonicalizer details (as built):

- `plane.offset` is the coordinate of the frame origin along the positive world axis of the base plane (XY: z, XZ: y, YZ: x), not along `frame.n`; it is the same sign convention even when the normal points the other way (the XZ plane's normal is -Y). Executors place the sketch from `frame`, not from `plane`.
- Geometry `id`s are the FreeCAD sketch geometry indices (construction geometry is skipped, so ids can have gaps). Arc angles are in `[0, 360)`; the arc runs counter-clockwise from `start_angle`, sweep = `(end_angle - start_angle) mod 360`. Only line, arc and circle are emitted (points of a hole sketch appear only in `positions`).
- `sketches` lists only sketches used by an exported feature, in document order.
- `hole` also has `positions: [[u,v], ...]` (circle centres and points of its sketch, sketch coordinates; the executor drills at these with the hole's own `diameter`) and `reversed`. Loop checks are not applied to hole sketches (circles may overlap).
- Directions verified in FreeCAD 1.1 with `n` = sketch normal: pad adds along `+n` (`reversed`: `-n`), pocket and hole remove along `-n` (`reversed`: `+n`). `direction` already includes `reversed`. `midplane` pad is symmetric; `direction` then only fixes the sign of the extrusion.
- `polar_pattern.axis.direction` is the body-placed origin axis, negated when FreeCAD's `Reversed` is set. With `full_circle`, FreeCAD spaces occurrences by `angle / occurrences`, otherwise `angle / (occurrences - 1)`.
- Sketches attached to a face of another feature (`sketch.on`) are rejected; use an origin plane with an offset. Pocket `midplane`, taper, custom direction vectors, two-sided and up-to extents, suppressed features, a body with a base feature, and features after the body Tip are rejected too.

### Canonicalizer error

The worker command returns an error with `code: "TRANSFER_UNSUPPORTED_OP"`, `target` = semantic path of the feature, `detail: { "op": "<type>", "option": "<name or null>", "reason": "..." }`. A tilted sketch plane uses `target` = the sketch path, `op: "sketch"`, `option: "tilted_plane"`; a face-attached sketch uses `option: "attached_to_face"`; hole options are `blind`, `thread`, `counterbore`, `countersink`.

Open, intersecting or touching loops return `code: "TRANSFER_INVALID_SKETCH"`, `target` = sketch path, `detail: { "reason": "open_loop" | "intersecting_loops" | "touching_loops" | "self_intersecting_loop" | "degenerate_geometry", "geometry": [ids] }`.

Worker command `export_features` (alias `export-features`), args `{ "output"?: path, "referenceStep"?: path }`, result `{ "features": <json>, "featureCount", "part", "path"?, "referenceStep"? }`. Read only.

## 2. Job folder (desktop <-> executor)

Root: `jobRoot` = Windows `%LOCALAPPDATA%\Reify\transfer`, macOS `~/Library/Application Support/Reify/transfer`.

```
<jobRoot>/fusion/heartbeat.json          written by the Fusion add-in every 5 s
<jobRoot>/fusion/inbox/<jobId>.json      written by the dispatcher (write *.tmp, then rename)
<jobRoot>/fusion/outbox/<jobId>/         written by the add-in
<jobRoot>/solidworks/jobs/<jobId>/       job.json in, results out (the executor runs once per job)
```

`job.json` (schema `reify.transfer.job/1`):

```json
{ "schema": "reify.transfer.job/1", "jobId": "20261007-abc123", "target": "fusion",
  "features": { "...canonical feature JSON..." },
  "output": { "native": "part.f3d", "check_step": "check.step" },
  "check": true, "timeoutS": 300 }
```

`outbox/<jobId>/` contents: `part.f3d` (or `part.SLDPRT`), `check.step`, `result.json`, `log.txt`.

`result.json` (schema `reify.transfer.result/1`):

```json
{ "schema": "reify.transfer.result/1", "jobId": "...", "ok": true, "target": "fusion",
  "executor": { "name": "ReifyExport", "version": "0.1.0", "app": "Fusion 2.0.xxxx" },
  "files": { "native": "part.f3d", "check_step": "check.step", "log": "log.txt" },
  "features_built": 7,
  "feature_volumes": [{ "name": "bracket/base", "volume_mm3": 6000.0 }],
  "error": null }
```

On failure `ok` is false and `error` is `{ "code": "EXECUTOR_FAILED" | "UNSUPPORTED_OP" | "BUSY", "message": "...", "feature": "bracket/base", "step": "extrude" }`. `feature` is the semantic name of the first feature that failed.

`heartbeat.json` (schema `reify.transfer.heartbeat/1`): `{ "pid": 1234, "version": "0.1.0", "app": "Fusion 2.0.xxxx", "updatedAt": "<ISO UTC>", "signedIn": true }`. The add-in is "running" when `updatedAt` is not older than 15 s.

## 3. Spool (sidecar <-> desktop dispatcher)

The sidecar runs as a child of Prime, possibly inside WSL. It cannot call Electron. It uses a spool folder in the project. The desktop main process watches it.

```
<project>/.pi-cad/transfer/dispatcher.json        desktop writes every 5 s: { schema, pid, updatedAt, targets: { fusion: <state>, solidworks: <state> }, detail }
<project>/.pi-cad/transfer/requests/<jobId>.json  sidecar writes (tmp + rename)
<project>/.pi-cad/transfer/status/<jobId>.json    desktop writes progress: { state: queued|running|done|failed|cancelled, message, updatedAt }
<project>/.pi-cad/transfer/results/<jobId>.json   desktop writes the final result (tmp + rename)
<project>/.pi-cad/transfer/cancel/<jobId>         sidecar creates this file to cancel
```

Target `<state>`: `ready`, `not_installed`, `addin_missing`, `addin_not_running`, `executor_missing`, `unsupported_platform`, `unavailable` (no dispatcher).

The dispatcher is alive when `dispatcher.json` `updatedAt` is not older than 15 s.

Request (schema `reify.transfer.request/1`): `{ jobId, target, features: <path of features.json, project-relative>, native: "exports/bracket.f3d", checkStep: "build/transfer/<jobId>/check.step", check: true, timeoutS }`.

Result (schema `reify.transfer.spool-result/1`): the executor `result.json` plus `files` as project-relative paths after the dispatcher copied them into the project. Error codes from the dispatcher: `TARGET_NOT_READY`, `EXECUTOR_FAILED`, `TIMEOUT`, `CANCELLED`.

One job at a time per executor. A second job for the same target waits in `queued`.

## 4. Error codes (Python `CadApiError.code`)

`TRANSFER_TARGET_NOT_READY`, `TRANSFER_UNSUPPORTED_OP`, `TRANSFER_EXECUTOR_FAILED`, `TRANSFER_CHECK_FAILED`, `TRANSFER_TIMEOUT`, `TRANSFER_UNAVAILABLE`.

## 5. Equivalence check

Executor STEP vs Reify STEP, both inspected with cadctl. Pass when: relative volume error <= 1e-6, bounding boxes equal within 1e-6 x part size, and face fingerprints match one to one. On failure, `detail` names the first feature whose `feature_volumes` entry differs from the reference by more than 1e-6 relative.
