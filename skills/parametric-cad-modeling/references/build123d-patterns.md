# build123d patterns

Load this reference while authoring build123d code. Keep the workflow card small; these details belong here.

## Coordinate discipline

- Declare which axis is width, depth, and height before creating geometry.
- Put the functional datum at the origin. Center symmetric parts on the relevant axes.
- Create repeated or mating geometry from named `Plane`, `Axis`, `Location`, and parameter values.
- Transform a feature once at its owning level. Avoid compensating rotations later in the tree.
- For a tilted member, calculate both endpoints or its local frame and verify them. A plausible angle alone does not prove the part points toward the intended side.

## Parameters

Separate four groups:

1. user or requirement values;
2. interface values shared with another part;
3. derived values calculated from the first two;
4. rendering-only values that never affect the STEP model.

Reject non-positive thicknesses, impossible ranges, and derived negative lengths before constructing shapes. Reuse one derived value rather than repeating arithmetic throughout the model.

For the desktop parameter panel, expose `build(parameters) -> Shape`. Keep the declaration passed to `cad.model.build` small; internal derived dimensions stay in Python.

## Part construction

Prefer this order:

1. primary envelope and load-bearing mass;
2. mating faces, axes, holes, slots, and hard clearances;
3. repeated functional features;
4. reliefs and manufacturing features;
5. fillets, chamfers, texture, and cosmetic cuts.

Build sketches on explicit planes. Close profiles before extrusion. Combine repeated cutters into a compound and subtract once when practical. A long chain of nearly tangent Boolean operations is slower and less reliable.

Use `BuildPart`/`BuildSketch` when their local frame makes feature ownership clear. Use algebra mode when explicit intermediate shapes make a Boolean or transform easier to inspect. Mixing the styles is fine if the resulting source remains deterministic.

## Holes and cylindrical interfaces

- Derive coaxial features from the same `Axis` or center coordinates.
- Distinguish radius from diameter in variable names.
- Extend a cutter beyond both sides of the target instead of ending exactly on a face.
- Keep clearance, press fit, and thread geometry as separate named decisions.
- Model real threads only when their geometry is required. Otherwise record the standard thread and model the proper pilot or clearance form.

## Repetition and symmetry

Use `Locations`, polar locations, grid locations, or a short data table rather than copied features. Reflect across a named datum plane. Verify the resulting count and at least one extreme location.

## Assemblies

Give every component a unique semantic label before export. Preserve supplier parts rather than rebuilding approximations. Own the transform at the assembly occurrence, not by permanently moving the source part.

Use build123d joints when motion or mating intent matters in source. STEP may not preserve every joint relation, so also verify world transforms and critical interfaces through the assembly and measure presets.

## Selection

During modeling, select by geometric condition: axis direction, plane orientation, extrema, radius, area range, or proximity to a named datum. Generated face order is not design intent.

After export, call `preset="surfaces"` and use its hash-bound `surf-*` values for measurements. Use occurrence refs from `preset="assembly"` for visual focus and hiding. Never carry either kind of ref to a rebuilt artifact.

## Delivery shape

Return one build123d `Shape` as `result`, or return it from `build(parameters)`. Let the managed build write the requested STEP. Do not make the authoritative result depend on viewer globals, current time, network data, random values, or undeclared files.
