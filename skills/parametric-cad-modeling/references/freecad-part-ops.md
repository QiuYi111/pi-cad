# FreeCAD part documents (`cad.part`)

Use `cad.part` for a **new part you will keep editing**: dimensions that change, features you add one at a time, poses you sweep. A parametric FreeCAD model (`.FCStd`) stays in memory between calls. You send small JSON ops instead of rewriting a script, and every change returns the seven standard views, a summary of what changed, and a structured error when it fails.

`cad.model.build` with build123d stays the default for one-shot geometry and for anything these ops cannot express. If a `cad.part` call raises `CadApiError` with `code == "FREECAD_NOT_INSTALLED"`, FreeCAD is not installed. Do not try to install it. Tell the user to run `npm run setup:freecad`.

## Python API

```text
doc = await cad.part.open(path, *, output=None, create=False, body=None, validation="auto") -> PartDocument
await doc.apply(ops, *, message=None, validation="auto", budget_s=None) -> PartResult
await doc.try_(ops, *, budget_s=None) -> PartResult          # shows the result, then discards it
await doc.undo() -> PartResult                               # back to the previous revision
await doc.tree() -> dict                                     # parameters, sketches (dof), roles, requirements
await doc.query(target, what=None) -> dict                   # what: params, bbox, volume, area, centroid, faces
await doc.check(kind, *, budget_s=None, **args) -> dict      # clearance, interference, wall_thickness, mass
await doc.sweep(param, range, *, step, check, refine=False, budget_s=None) -> dict
```

- `path` is a project path ending in `.FCStd`. `output` defaults to `build/<stem>.step`. `body` is the semantic path of the first body (default: the file name).
- `apply` runs all ops in **one transaction**. If any op or the recompute fails, nothing changes: the error says so (`rolled_back`) and names the failing op (`detail["failedOpIndex"]`). Send related edits together.
- `PartResult` has `rev`, `artifact` (an `ArtifactRef` you can pass to `cad.probe.run`), `changes`, `features`, `params`, `intent`, `warnings`.
- Every `open`, `apply`, `undo` and `try_` attaches the seven views. `CadApiError` carries `code`, `target`, `detail`, `hints` and `rolled_back`.

### What the views show

- **Orange faces** are faces on a surface the previous build did not have: a new hole wall, a moved plane, a fillet. A face that only got smaller (a plate that gained a hole) keeps its colour.
- **Labels** name features at a visible face (`mount_hole`, `edge_round`). The first build labels every feature.
- The first image's text starts with `Changes since previous build:` (volume, faces, bounding box), then recomputed features, changed parameters, intent results and warnings. Read it before the pictures.
- If most faces changed, nothing is coloured: the shading is more useful than an all-orange part.

## Names

Every object has a **semantic path**: `bracket`, `bracket/base`, `bracket/mount_hole`. Segments are joined by `/`. A segment may not be a bare number, empty, or have leading or trailing spaces; `/` inside a name is written `%2F` (the rules of `docs/identity-protocol.md`). Paths start with the body path (`body="bracket"`), which is how an op finds its body.

A feature path may not end in a **role name** (`top`, `bottom`, `side`, `wall`, `floor`, `round`, `bevel`, `rim`, `top_outer`, `counterbore_floor`, `counterbore_wall`, `countersink`). `bracket/round` is refused; use `bracket/edge_round`.

Faces are never named `Face12`. A face is `<feature path>/<role>`, found again after every rebuild:

| Feature | Roles |
|---|---|
| `pad` | `top` (far end face), `bottom` (end face on the sketch plane), `side.<k>` |
| `pocket` | `floor` (blind pockets), `wall.<k>` |
| `hole` | `wall`, `bottom` (blind), `counterbore_floor`, `counterbore_wall`, `countersink` |
| `fillet` | `round` |
| `chamfer` | `bevel` |
| pattern or mirror of a feature | the original role plus `@n` for instance n >= 2: `wall@2`, `wall@3` |

- `<k>` is the index of the sketch geometry that made the face. `rect` makes four lines in the order bottom (y-), right (x+), top (y+), left (x-): `side.0` faces -y, `side.1` faces +x, `side.2` faces +y, `side.3` faces -x. A circle is `side.0` or `wall.0`. `slot`: line, arc at the end point, line, arc at the start point. `polyline`: segment i is `.i`.
- A role like `side` also covers `side.0`, `side.1` and so on. `wall` is exactly the first instance of a pattern; `wall@*` is every instance.
- When a role holds several faces (four holes from one sketch) it still has one name; use `doc.query(path, ["faces"])` to see them.
- Edge roles, for `fillet` and `chamfer`: `<pad>/top_outer` (outer edges of the top face), `<hole or pocket>/rim` (the edges where the wall meets the face the cut opens into), and `{"between": [selector, selector]}` (the edges two face roles share).
- If a selector matches nothing you get `TARGET_NOT_FOUND` with the nearest known names. If it matches several faces where one is needed, `TARGET_AMBIGUOUS` lists candidates with centres.

## Numbers and expressions

A value is a number (mm, or degrees for angles) or a string that starts with `=`:

```text
"=width/2"            parameters of the Params object are written by name
"=width - 3 mm"      constants in expressions need units
"=j3_angle"           a placement angle driven by a parameter
```

Declare a parameter once with `{"op": "param", "name": "width", "value": 40, "unit": "mm"}` (`unit` is `mm`, `deg`, or omitted for a plain number). Send `param` again to change it: that recomputes only what depends on it. An unknown name gives `EXPRESSION_INVALID` with the known parameters.

## Ops

| op | required | optional | notes |
|---|---|---|---|
| `param` | `name`, `value` | `unit` | a number or `=expression` |
| `body` | `name` | | starts another body (an assembly part); later ops build in it |
| `sketch` | `name`, `shapes`, and `plane` (`XY`, `XZ`, `YZ`) or `on` | `offset`, `body` | `on` is a face selector `{"feature", "role"}`; `offset` moves the sketch along its normal |
| `pad` | `name`, `sketch`, `length` | `reversed`, `midplane`, `type` (`length`, `through_all`, `up_to_face`), `face` | `up_to_face` needs `face: {"feature", "role"}` |
| `pocket` | `name`, `sketch`, `depth` | `type` (`length`, `through_all`), `reversed` | cuts into the material |
| `hole` | `name`, `sketch` (circles or points), `diameter` | `depth`, `type` (`blind`, `through_all`), `thread` (`"M6"`), `counterbore` `{"diameter", "depth"}`, `countersink` `{"diameter", "angle"}` | a blind hole needs `depth` |
| `fillet` | `name`, `edges`, `radius` | | `edges` is one edge selector or a list |
| `chamfer` | `name`, `edges`, `size` | | |
| `linear_pattern` | `name`, `features`, `direction` (`X`, `Y`, `Z`, `-X` ...), `length`, `count` | | `length` is the distance from the first to the last instance |
| `polar_pattern` | `name`, `features`, `axis`, `angle`, `count` | | `angle` 360 spreads the instances around the circle |
| `mirror` | `name`, `features`, `plane` | | |
| `set` | `target`, `prop`, `value` | | see below |
| `delete` | `target` | | `HAS_DEPENDENTS` lists what still uses it |
| `rename` | `target`, `to` | | children and requirements follow |
| `placement` | `target` (a body) | `position`, `rotation` `{"axis", "angle"}` | values may be `=expressions`: this is how poses are driven |
| `require` | `name`, `kind`, `target`, `limit` | `tolerance` | an intent, checked after every apply |

`set` changes `Length`, `Length2`, `Depth`, `Diameter`, `Radius`, `Size`, `Occurrences`, `Angle`, `Reversed`, `Midplane`, `Type`, any parameter (`target: "Params"`), or a named sketch constraint (`prop: "constraint:s0_w"`). Anything else is `PROP_NOT_ALLOWED`, and the error lists what is allowed.

### Sketch shapes

Each shape is fully constrained when it is built, and its dimensions are named so `set` and expressions can reach them.

```text
{"rect": {"center": [0, 0], "size": ["=width", 20]}}       constraints s0_w, s0_h, s0_c_x, s0_c_y
{"rect": {"corner": [0, 0], "size": [40, 20]}}             corner = lower left; s0_w, s0_h, s0_p_x, s0_p_y
{"circle": {"center": [10, 0], "diameter": "=hole_d"}}     s0_d, s0_c_x, s0_c_y
{"slot": {"start": [0, 0], "end": [20, 0], "width": 6}}    s0_r, s0_a_x, s0_a_y, s0_b_x, s0_b_y
{"polyline": {"points": [[0,0],[40,0],[40,10]], "closed": true}}   s0_p0_x, s0_p0_y ...
{"point": {"at": [10, 5]}}                                  s0_p_x, s0_p_y
```

`s0` is the shape's index in `shapes`; give a shape `"name": "slot_a"` to get `slot_a_w` and so on. An open profile cannot be padded: `SKETCH_PROFILE_NOT_CLOSED`.

### Intents

`require` kinds: `min_wall` (target path, limit mm), `min_clearance` (target `{"a", "b"}`, limit mm), `max_mass` (target path or null, limit g; density is the parameter `density` in g/cm3, default 2.7), `bbox_within` (target path, limit `[x, y, z]`), `dimension` (target `{"target", "prop"}`, limit). A failed intent is a result (`status: "fail"` in `r.intent`), not an error.

## Checks and sweeps

```python
await doc.check("clearance", a="arm/upper", b="arm/base")               # minimum distance and the two closest points
await doc.check("interference", all=True)                               # volume of overlap for each body pair
await doc.check("wall_thickness", target="bracket", samples=200)        # minimum wall by inward rays
await doc.check("mass", target="bracket")                               # mass, centre of mass, inertia
await doc.sweep("j3_angle", (-90, 90), step=2, check=("clearance", {"a": "arm/upper", "b": "arm/base"}), refine=True, budget_s=300)
```

These read the in-memory shapes; nothing is exported. A sweep varies one parameter, restores it, and does not change the document. It returns the number of samples, the minimum and where it happens, `firstFailure`, `failureIntervals`, and `worstPose`; the views show the worst pose. A clearance of 0 or an interference above 0 counts as a failure; pass `fail_below` or `fail_above` in the check's arguments to choose another limit. `refine=True` bisects every pass or fail boundary down to `step / 8`.

A check that runs past `budget_s` (default 30, at most 600) is stopped. Raise `budget_s` or split the check.

## Errors

| `code` | when | `detail` | `hints` |
|---|---|---|---|
| `FREECAD_NOT_INSTALLED` | no FreeCAD runtime | `searched` | `run: npm run setup:freecad` |
| `FREECAD_WORKER_RESTARTED` | the worker died; the request did not run to the end | `stderrTail` | `retry` |
| `OP_SCHEMA_INVALID` | a malformed op; nothing ran | `opIndex`, `path`, `reason` | |
| `TARGET_NOT_FOUND` | unknown path or role | `target`, `known` | |
| `TARGET_AMBIGUOUS` | a selector matched several faces | `candidates` | `add role or between` |
| `NAME_CONFLICT` | the path exists, or ends in a role name | | `rename or use set` |
| `HAS_DEPENDENTS` | `delete` of something in use | `dependents` | |
| `PROP_NOT_ALLOWED` | `set` of another property | `allowed` | |
| `EXPRESSION_INVALID` | an unknown name, or a missing unit | `expression`, `reason`, `known` | `write units in expressions` |
| `SKETCH_CONFLICTING`, `SKETCH_REDUNDANT`, `SKETCH_MALFORMED` | solver diagnostics, degenerate geometry | `constraints` (id and name) | |
| `SKETCH_PROFILE_NOT_CLOSED` | the profile has a gap | | |
| `FILLET_FAILED`, `CHAMFER_FAILED`, `HOLE_FAILED`, `PATTERN_FAILED`, `BOOLEAN_FAILED`, `FEATURE_FAILED` | a feature did not recompute | `feature`, `freecadStatus` | `reduce radius`, `fillet before pocket` ... |
| `RESULT_NOT_SOLID`, `RESULT_MULTIPLE_SOLIDS` | a body is not one valid solid | `body`, `solids`, `validity` | |
| `IDENTITY_BIND_FAILED` | the STEP could not be bound to the names; the apply was undone | `paths` | |
| `BUDGET_EXCEEDED`, `BUDGET_EXCEEDS_LIMIT`, `CANCELLED` | time limit, or an interrupted request | `budgetS`, `limitS` | `increase budget_s`, `split the check` |

Under-constrained sketches are warnings (`SKETCH_UNDER_CONSTRAINED`, with the remaining degrees of freedom), not errors. Shapes from `sketch` are always fully constrained.

## Not supported in v1

Assembly constraints (use `placement` with parameters), lofts, sweeps, revolves, sketch constraints beyond the shapes above, selecting by `Face12` or `Edge7`, threads that are modelled in 3D, and inserting a feature before an earlier one (features append; edit with `set` instead).

## Example 1: bracket with four mounting holes, then a wider hole

```python
doc = await cad.part.open("parts/bracket.FCStd", create=True, body="bracket")
r = await doc.apply(batch_1, message="plate and holes")     # batch_1 and batch_2 are the JSON below
r = await doc.apply(batch_2)                                # one op: the views show only the hole walls in orange
```

```json op-batch bracket 1
[
  {"op": "param", "name": "hole_d", "value": 6, "unit": "mm"},
  {"op": "sketch", "name": "bracket/base_profile", "plane": "XY",
   "shapes": [{"rect": {"center": [0, 0], "size": [80, 50]}}]},
  {"op": "pad", "name": "bracket/base", "sketch": "bracket/base_profile", "length": 6},
  {"op": "sketch", "name": "bracket/hole_profile", "on": {"feature": "bracket/base", "role": "top"},
   "shapes": [
     {"circle": {"center": [-30, -15], "diameter": "=hole_d"}},
     {"circle": {"center": [30, -15], "diameter": "=hole_d"}},
     {"circle": {"center": [-30, 15], "diameter": "=hole_d"}},
     {"circle": {"center": [30, 15], "diameter": "=hole_d"}}]},
  {"op": "hole", "name": "bracket/mount_hole", "sketch": "bracket/hole_profile", "diameter": "=hole_d", "type": "through_all"},
  {"op": "fillet", "name": "bracket/edge_round", "edges": {"feature": "bracket/base", "role": "top_outer"}, "radius": 2},
  {"op": "require", "name": "bracket/max_mass", "kind": "max_mass", "target": "bracket", "limit": 70}
]
```

```json op-batch bracket 2
[
  {"op": "set", "target": "Params", "prop": "hole_d", "value": 8}
]
```

## Example 2: a box with a pocket and rounded rim

```json op-batch box 1
[
  {"op": "sketch", "name": "box/outline", "plane": "XY", "shapes": [{"rect": {"corner": [0, 0], "size": [60, 40]}}]},
  {"op": "pad", "name": "box/body", "sketch": "box/outline", "length": 25},
  {"op": "sketch", "name": "box/cavity_profile", "on": {"feature": "box/body", "role": "top"},
   "shapes": [{"rect": {"corner": [3, 3], "size": [54, 34]}}]},
  {"op": "pocket", "name": "box/cavity", "sketch": "box/cavity_profile", "depth": 22},
  {"op": "fillet", "name": "box/outer_edges",
   "edges": {"between": [{"feature": "box/body", "role": "side"}, {"feature": "box/body", "role": "bottom"}]}, "radius": 3},
  {"op": "require", "name": "box/wall_thickness", "kind": "min_wall", "target": "box", "limit": 2.5}
]
```

```json op-batch box 2
[
  {"op": "chamfer", "name": "box/lip", "edges": {"feature": "box/cavity", "role": "rim"}, "size": 0.8}
]
```

`{"feature": "box/body", "role": "side"}` covers `side.0` to `side.3`, so `between` side and bottom is the four bottom edges.

## Example 3: two links and a pose sweep

```json op-batch arm 1
[
  {"op": "param", "name": "j3_angle", "value": 0, "unit": "deg"},
  {"op": "sketch", "name": "arm/base/sk", "plane": "XY", "shapes": [{"rect": {"corner": [-20, -20], "size": [40, 40]}}]},
  {"op": "pad", "name": "arm/base/block", "sketch": "arm/base/sk", "length": 20},
  {"op": "body", "name": "arm/upper"},
  {"op": "sketch", "name": "arm/upper/sk", "plane": "XY", "body": "arm/upper",
   "shapes": [{"rect": {"corner": [0, -5], "size": [80, 10]}}]},
  {"op": "pad", "name": "arm/upper/link", "sketch": "arm/upper/sk", "length": 10},
  {"op": "placement", "target": "arm/upper", "position": [0, 0, 25], "rotation": {"axis": [0, 1, 0], "angle": "=j3_angle"}}
]
```

```python
doc = await cad.part.open("parts/arm.FCStd", create=True, body="arm/base")
await doc.apply(arm_1)
sweep = await doc.sweep(
    "j3_angle", (-90, 90), step=10,
    check=("clearance", {"a": "arm/upper", "b": "arm/base"}), refine=True, budget_s=120,
)
sweep["firstFailure"]      # the smallest angle that collides, found to within step / 8
sweep["worstPose"]         # the views show the arm at this angle, with both parts labelled
```
