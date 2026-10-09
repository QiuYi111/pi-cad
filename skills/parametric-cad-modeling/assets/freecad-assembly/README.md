# FreeCAD assembly asset

One part is one document and one assembly is one document. Each part has an owner (a subagent, or you); the assembly links the parts and seats them with joints.

- `base.ops.json` and `link.ops.json` build two parts, each in its own `.FCStd`.
- `assembly.ops.json` links both, adds a revolute joint with limits, and an intent on the clearance between them.
- `build.py` shows the calls: build the parts, link them, edit a part, apply again, sweep the joint.

Replace the part paths, the roles in the joint (`parent` and `child` name a cylinder, cone or plane face), and the limits. A bought-in STEP is added with `import_step` (see the reference document); do not model a supplier part again.

The reference for every op is `skills/parametric-cad-modeling/references/freecad-part-ops.md`.
