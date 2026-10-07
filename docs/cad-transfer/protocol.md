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

## 6. P2 additions (additive; the schema name stays `reify.features/1`)

Executors still reject any feature `type` they do not know. New optional keys are ignored by old readers.

- **`linear_pattern`**: `{ name, type, originals: [feature names], direction: [x,y,z] (world, unit), length: {value, expr?} (first to last instance), occurrences: int, spacing: {value} (= length/(occurrences-1)), reversed }`. `direction` already includes `reversed`.
- **`mirror`**: `{ name, type, originals: [feature names], plane: { origin: [x,y,z], normal: [x,y,z] } }` in world coordinates (Body placement applied).
- **Sketch dimensions (level-1 constraints)**: `sketches[].dimensions = [{ name, kind, refs, value: {value, expr?} }]`. `kind` is `distance` (length of a line, or distance between two points), `distance_x`, `distance_y`, `radius`, `diameter` or `angle` (degrees). `refs` is a list of `[geometry id, position]`; position is `0` for the whole element, `1` start, `2` end, `3` centre, and the origin is `[-1, 1]`. The value equals the value the geometry already has. Executors add the dimension after they draw the geometry, so nothing moves. An executor that cannot add a dimension fails with `EXECUTOR_FAILED` and names the sketch. Geometric constraints (coincident, tangent, ...) are not sent at level 1.
- **Material**: top-level `material: { "name": "<optional>", "density_kg_m3": 7850.0 }`, only when the Reify part declares a density. Executors set the density of the body (Fusion: a physical material or the body material property; SolidWorks: `MaterialPropertyValues`/mass override). The result `feature_volumes` check is not affected.
- **Assemblies**: a second JSON, schema `reify.assembly/1`:
  `{ schema, units: "mm", name, parts: [{ ref: "parts/axle.FCStd", name: "axle", features: <reify.features/1 object> }], occurrences: [{ name: "asm/axle_1", part: "parts/axle.FCStd", transform: { origin: [x,y,z], rotation: [[r00,r01,r02],[r10,r11,r12],[r20,r21,r22]] } }] }`.
  Positions only: no joints, no mates. `transform` maps part coordinates to assembly (world) coordinates. A job with an assembly has `job.json` `kind: "assembly"` and `assembly` in place of `features`. The executor builds each occurrence from its part's features inside its own component (Fusion) or part file plus `AddComponent` (SolidWorks), at the given transform. The verification STEP is the whole assembly; `feature_volumes` entries are named `<occurrence name>` (volume of each occurrence).
  Spool request gets `"kind": "assembly"` and `"assembly": "<project-relative path of the assembly JSON>"` in place of `features`.

## 7. P3 additions

- **Parameters (level 2)**: top-level `parameters: [{ name, value, unit: "mm"|"deg"|"", expr? }]` (the Reify `Params`). A scalar's `expr` names these parameters (`=width/2`). Executors create user parameters (Fusion `userParameters`) or equations (SolidWorks `EquationMgr`) and bind the feature values with an expression string. Supported expression grammar: numbers, parameter names, `+ - * /`, parentheses, units `mm` and `deg`. If an expression is outside the grammar, the executor uses the evaluated `value` for that scalar and adds an entry to `result.json` `warnings: [{ feature, field, expr, reason }]`. A feature is never skipped.
- **Holes**: `hole.extent` can be `{ type: "through_all" }` or `{ type: "blind", depth: {value, expr?} }`. New optional keys: `drill_point: { type: "flat" | "angled", angle_deg: 118 }` (FreeCAD blind holes default to angled), `counterbore: { diameter, depth }`, `countersink: { diameter, angle_deg }`, `thread: { standard: "ISO", size: "M6", pitch_mm, modeled: false }` (cosmetic only; `modeled: true` is rejected). Executors use the native hole feature (Fusion `holeFeatures`, SolidWorks Hole Wizard) so the tree shows a Hole. Through holes keep working as before.
- **Edge references (fillet, chamfer)**: `fillet: { name, type, edges: [edge_ref], radius: {value, expr?} }`, `chamfer: { ..., size: {value, expr?} }`. An `edge_ref` is geometric, in world coordinates, and is resolved in the body state **before** the feature: `{ curve: "line" | "circle" | "arc", midpoint: [x,y,z], length: mm, start?: [x,y,z], end?: [x,y,z], centre?: [x,y,z], radius?: mm, axis?: [x,y,z] }`. Executors find the one edge of the current body whose curve type matches and whose midpoint is within `1e-4` mm times the part diagonal and whose length matches; zero or several matches is an error naming the feature. The canonicalizer rejects a feature whose edges are not unique by this description.
- **Face references**: `face_ref: { origin: [x,y,z] (a point on the face), normal: [x,y,z] (outward), area: mm2 }` for planar faces. Executors find the planar face whose plane contains `origin` and has the same normal (either sign) and the same area (1e-4 relative).
- **Sketches on faces**: a sketch attached to a planar face is exported with its global `frame`. If the frame is parallel to a world axis the sketch stays on `plane.base` + `plane.offset` (nothing new). A tilted frame adds `sketch.face_ref`, and the executor sketches on that face. Non-planar faces are `TRANSFER_UNSUPPORTED_OP`.
- **`up_to_face`**: `pad.extent = { type: "up_to_face", face_ref }` (planar face only; the face exists before the pad). Fusion `ToEntentExtent`, SolidWorks `UpToSurface`/`UpToFace`.

## 8. Canonicalizer notes for P2/P3 (as built)

- **Face sketches**: allowed. A sketch on a planar face of an earlier feature exports its global `frame`; if the frame is axis-parallel it is `plane: { base, offset }` as for any sketch. A tilted one has `plane: null` and `face_ref` (see section 7). A non-planar face is `TRANSFER_UNSUPPORTED_OP` (`op: "sketch"`, `option: "non_planar_face"`). Tilted sketches on origin planes (rotated Body) stay `option: "tilted_plane"`.
- **Dimensions**: only named, driving Distance/DistanceX/DistanceY/Radius/Diameter/Angle constraints. A DistanceX/DistanceY that names one point (FreeCAD: the point's coordinate) is exported with `refs: [[-1,1],[geo,pos]]`. A line's own DistanceX/Y has `refs: [[geo,0]]` (end minus start, signed). Dimensions that touch construction geometry are dropped (that geometry is not exported). `expr` has FreeCAD binding noise removed (`1 * 0 mm + -0.5 * Params.width` becomes `=-0.5*width`).
- **Material**: the Reify part declares density as the `Params` entry `density` in g/cm3 (the one `mass`/`max_mass` use). `material.density_kg_m3 = density * 1000`, no `name`. No `density` parameter, no `material` key (the default 2.7 used by `mass` is not exported).
- **Parameters**: sorted by name; `unit` is `mm` (length), `deg` (angle) or `""`; `expr` only for parameters bound to an expression.
- **Holes**: `extent` is `through_all` or `blind` (`depth`). `drill_point` is emitted for blind holes only: `{ type: "angled", angle_deg }` (FreeCAD default angled, 118) or `{ type: "flat", angle_deg: 180 }`. Counterbore/countersink keys carry scalars (`diameter`, `depth`) and `angle_deg` is a plain number. `thread.pitch_mm` comes from FreeCAD's `ThreadSize` (`M6x1.0`). Still rejected: `modeled_thread`, `thread_type` (non-ISO metric), `tapered`, `midplane`, `drill_for_depth`, other depth types.
- **Edge refs**: world coordinates in the state before the feature. For a closed circle the `midpoint` is the curve's parameter middle (seam dependent): executors should match circles by `centre`, `radius`, `axis` and `length` and use `midpoint` only for lines and arcs. Uniqueness is checked with `1e-4 * diagonal` on midpoint and length. Rejections: `ambiguous_edge`, `edge_curve` (not line/circle/arc), `chamfer_type` (not equal distance), `no_edges`.
- **Pad up to face**: `extent: { type: "up_to_face", face_ref }`, direction `+n` (FreeCAD pads along the sketch normal until the face; verified). `reversed` with up-to-face is `reversed_up_to_face`, a face offset is `offset`, non-planar end faces are `non_planar_face`; other up-to types and pocket up-to stay unsupported.
- **Patterns**: `Mode = Spacing` is `spacing_mode` (linear) / `offset_mode` (polar). Direction/axis must be an origin axis of the body, mirror plane an origin plane, else `direction` / `axis` / `plane`.
- **Assembly export**: worker command `export_assembly` (alias `export-assembly`), args `{ output?, referenceStep? }`, result `{ assembly, partCount, occurrenceCount, part, path?, referenceStep? }`. `reify.assembly/1` also has `source: { doc }` and `reference: { volume_mm3, bbox, feature_volumes: [{ name: <occurrence>, volume_mm3 }] }`. `parts[].ref` is the `LinkPart` path (`path#body` when one document is used for two bodies); `parts[].features` is the full `reify.features/1` object of that body (own `source`, `parameters`, `material`, `reference`). `transform.origin/rotation` is the occurrence Placement with joints solved. A bought-in STEP unit is `TRANSFER_UNSUPPORTED_OP` with `target` = the unit path, `op: "import_step"`, `option: "reference"`; a body with features inside the assembly document is `option: "inline_body"`. `export_features` on an assembly document keeps raising `op: "assembly"`, `option: "occurrence"`.
