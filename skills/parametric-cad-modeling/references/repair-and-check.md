# Repair and check

## Diagnose before editing

Classify the failure:

- Python or API error;
- empty or wrong result object;
- failed Boolean;
- invalid/open/inverted/self-intersecting B-Rep;
- wrong frame or transform;
- correct geometry with wrong design interpretation;
- acceptable nominal build that fails at a parameter boundary.

Read the exact error and the latest visual/geometry observation. Change one cause at a time.

## Boolean repair

Check that operands really overlap and are in the same frame. Remove exact tangency by extending cutters or using a justified geometric tolerance. Simplify compound cutters. Move decorative features after structural Booleans. If the operation still fails, isolate the smallest pair of shapes that reproduces it.

Do not hide a Boolean failure by returning the pre-cut solid or by exporting a different object than the one reviewed.

## Wrong pose or mirrored geometry

Probe front/back and both isometric directions. Check the world triad. Calculate a known endpoint or mating-plane normal. Repair the owning `Location`, axis, or sign; do not stack compensating rotations until one screenshot looks right.

## Fragile topology

Replace face-index selection with a geometric selector or named construction datum. Keep fillets late. If a feature can disappear over the supported parameter range, branch explicitly or narrow the declared range.

## Minimum regeneration matrix

Test the nominal value and meaningful low/high values for parameters that change thickness, spacing, count, angle, or clearance. For each build check:

- expected solid and occurrence count;
- positive bounds and volume;
- generic B-Rep validity;
- critical radii, distances, and alignments;
- visual orientation;
- assembly interference at relevant poses.

The checks report geometry, not whether the design meets the user's intent. Compare facts with the committed requirement and interface records yourself.

## Stop rules

Do not repeat an unchanged build. If geometry is sound but the requirement has two materially different readings, stop and ask. If an external standard or supplier interface is missing, identify the exact missing input rather than inventing it.
