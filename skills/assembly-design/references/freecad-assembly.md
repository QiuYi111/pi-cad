# Building the assembly with `cad.part`

`cad.part` is the default way to build an assembly. Its op table, role names and error codes are in `skills/parametric-cad-modeling/references/freecad-part-ops.md`; the copyable example is `skills/parametric-cad-modeling/assets/freecad-assembly`. This note is the workflow.

## Split the work

1. **One part, one document.** Every part is `parts/<name>.FCStd` with one owner. With subagents, each subagent owns one part document (in its own folder) and nothing else.
2. **One assembly, one document.** The parent owns `assembly/<name>.FCStd`. It never edits a part; it links the part documents.
3. **Agree the interfaces before the parts exist.** Write, for each part, the feature names that others will use: the bearing seat `link/bearing` (hole) with its `wall`, the mounting face `base/plate` with its `top`. A subagent returns its document path, its body path, and these role paths. The parent joints on them.
4. **Bought-in parts** are STEP files in `imports/`. Add them with `import_step`; keep the supplier geometry and put the keep-outs in the interface record. Do not remodel them.

## Build it

```python
arm = await cad.part.open("assembly/arm.FCStd", create=True, body="arm")
await arm.apply([
    {"op": "param", "name": "j3_angle", "value": 0, "unit": "deg"},
    {"op": "link", "name": "arm/upper", "part": "parts/upper.FCStd", "body": "upper"},
    {"op": "link", "name": "arm/forearm", "part": "parts/forearm.FCStd", "body": "forearm"},
    {"op": "import_step", "name": "arm/motor_j3", "file": "imports/motor.step", "position": [0, 0, 40]},
    {"op": "joint", "name": "arm/j3", "type": "revolute", "value": "=j3_angle", "limits": [-90, 90],
     "parent": {"feature": "arm/upper/elbow_pin", "role": "wall"},
     "child": {"feature": "arm/forearm/j3_bearing_seat", "role": "wall"}},
])
```

- A joint's `parent` and `child` each name one face role. A cylinder or cone role gives an axis; a plane role gives a normal (use `"flip": true` to seat the child face to face).
- Seat parents before children: joints are applied in the order they were added.
- A through hole's cylinder has no fixed origin along its axis. When the position along the axis matters, joint on a plane role (a shoulder, a top face).

## Verify

- `await arm.check("interference", all=True)` lists every pair of bodies, occurrences and references with the overlap volume (bounding boxes first). `await arm.check("clearance", a="arm/forearm", b="arm/upper")` gives the distance and the closest points.
- Sweep each joint over its range: `await arm.sweep("arm/j3", (-90, 90), step=2, check=("clearance", {"a": "arm/forearm", "b": "arm/upper"}), refine=True)`. `firstFailure` is the first angle that collides, found to within `step / 8`; `worstPose` is shown in the seven views with both parts labelled.
- Declare joint `limits` and `require` intents (`min_clearance`, `bbox_within`, `max_mass`). They are checked after every apply and reported in `r.intent`.
- Look at the seven views after every apply. Use `focus` and `hide` with occurrence paths in the visual probe to inspect one part.

## Change a part

Apply the change in the part's own document. The next `apply`, `open` or `check` on the assembly takes the new revision: the changed occurrences are listed in `features.recomputed`, their changed faces are orange, and the joints seat them again. Then re-run the interference and sweep checks. If the change breaks a joint (a role that no longer exists), the apply fails with `TARGET_NOT_FOUND` and the assembly document stays as it was.

## Fits and tolerances

The checks above find collisions and clearances of the nominal geometry. Fit classes, tolerance stacks and service access stay as described in the other references of this skill; a sweep is not a tolerance analysis.
