# FreeCAD part asset

Copy this directory into the project, replace the named parameters and feature names, then run the batches with `cad.part`.

- `part.ops.json` builds a plate with four parameter-driven mounting holes, a rounded rim, and two intents (mass and bounding box).
- `edit.ops.json` is one edit: a wider hole. It changes the parameter, not a script.
- `build.py` shows the calls. Run it in the persistent IPython kernel (it uses `await`).

Replace the dimensions, `bracket` paths and hole positions. Keep the structure: named parameters first, one sketch per feature, features named by what they do (not by role names), intents last.

The reference for every op is `skills/parametric-cad-modeling/references/freecad-part-ops.md`.
