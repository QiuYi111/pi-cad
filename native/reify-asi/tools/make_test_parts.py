#!/usr/bin/env python3
"""Builds the reify-asi test parts with the FreeCAD Part API and writes .brep files.

Run with the FreeCAD environment's Python (see docs/dfm/spike-results.md):

    E=$HOME/.local/share/pi-cad/runtimes/freecad/env
    PYTHONPATH=$E/lib $E/bin/python native/reify-asi/tools/make_test_parts.py OUTDIR

Each part is written as OUTDIR/<name>.brep with shape.exportBrep(). A JSON file
OUTDIR/<name>.freecad.json records FreeCAD's own face order (Shape.Faces, the
in-memory shape before export) so that check_face_ids.py can compare.

Units are mm. Coordinates: X/Y in the plate plane, Z up.
"""
import json
import math
import os
import sys

import FreeCAD  # noqa: F401  (imported for the Part module's document context)
import Part
from FreeCAD import Vector


def _cyl(x, y, z0, d, h):
    return Part.makeCylinder(d / 2.0, h, Vector(x, y, z0), Vector(0, 0, 1))


def _vertical_edges(shape):
    return [e for e in shape.Edges
            if abs(e.Vertexes[0].Point.z - e.Vertexes[-1].Point.z) > 1e-6
            and abs(e.Vertexes[0].Point.x - e.Vertexes[-1].Point.x) < 1e-9
            and abs(e.Vertexes[0].Point.y - e.Vertexes[-1].Point.y) < 1e-9]


def build_parts():
    """Returns an ordered dict name -> Part.Shape."""
    parts = {}

    # Acceptance plate: 40 x 30 x 5 with 4 through holes of diameter 3.
    plate = Part.makeBox(40, 30, 5)
    for x, y in [(8, 8), (32, 8), (8, 22), (32, 22)]:
        plate = plate.cut(_cyl(x, y, -1, 3.0, 7))
    parts["plate_4holes"] = plate

    # Acceptance blind hole: d = 4, depth 6 from the top face of a 40 x 30 x 10 block, flat bottom.
    blind = Part.makeBox(40, 30, 10).cut(_cyl(20, 15, 4, 4.0, 10))
    parts["blind_d4_depth6"] = blind

    # Acceptance pocket with R2 corners: 20 x 14 x 4 deep, vertical corners filleted R2.
    pocket_tool = Part.makeBox(20, 14, 4, Vector(10, 8, 6))
    pocket_tool = pocket_tool.makeFillet(2.0, _vertical_edges(pocket_tool))
    parts["pocket_r2"] = Part.makeBox(40, 30, 10).cut(pocket_tool)

    # Acceptance thin wall 0.6 mm: an open-top channel leaves two 0.6 mm walls at x=0..0.6 and x=39.4..40.
    thin = Part.makeBox(40, 30, 10).cut(Part.makeBox(38.8, 20, 8, Vector(0.6, 5, 2)))
    parts["thin_wall_0p6"] = thin

    # Additional shapes for the face ID comparison (E0-b).
    parts["box_plain"] = Part.makeBox(20, 20, 20)
    parts["cylinder_shaft"] = Part.makeCylinder(5, 20)
    parts["cone_frustum"] = Part.makeCone(10, 5, 20)
    parts["sphere_cut_block"] = Part.makeBox(30, 30, 30).cut(
        Part.makeSphere(18, Vector(15, 15, 30)))
    parts["l_bracket"] = Part.makeBox(30, 10, 5).fuse(Part.makeBox(10, 10, 30, Vector(0, 0, 0)))
    fbox = Part.makeBox(30, 20, 10)
    parts["filleted_box"] = fbox.makeFillet(1.0, [
        e for e in fbox.Edges if abs(e.BoundBox.ZMin - 10) < 1e-6 and abs(e.BoundBox.ZMax - 10) < 1e-6])
    # Countersink: 90 degree cone, radius 3.2 at z=3.2 widening to radius 6.0 at the top face z=6.
    parts["countersunk_plate"] = Part.makeBox(30, 20, 6).cut(
        _cyl(15, 10, -1, 3.2, 8)).cut(Part.makeCone(3.2, 6.0, 2.8, Vector(15, 10, 3.2), Vector(0, 0, 1)))
    parts["tube"] = Part.makeCylinder(10, 20).cut(Part.makeCylinder(7, 20))
    parts["grid_blind_200"] = _grid_blind(10, 10, 10.0, 6.0, 10.0, 4.0, 3.0)
    return parts


def _grid_blind(nx, ny, pitch, margin, height, d, depth):
    """A plate of nx x ny blind holes (flat bottoms): about 200 faces at 10 x 10."""
    w = margin * 2 + pitch * (nx - 1)
    h = margin * 2 + pitch * (ny - 1)
    body = Part.makeBox(w, h, height)
    for i in range(nx):
        for j in range(ny):
            x = margin + pitch * i
            y = margin + pitch * j
            body = body.cut(_cyl(x, y, height - depth, d, depth + 1))
    return body


def write_parts(outdir):
    os.makedirs(outdir, exist_ok=True)
    manifest = []
    for name, shape in build_parts().items():
        brep = os.path.join(outdir, name + ".brep")
        shape.exportBrep(brep)
        faces = []
        for i, f in enumerate(shape.Faces, start=1):
            faces.append({"id": i, "centroid": [f.CenterOfMass.x, f.CenterOfMass.y, f.CenterOfMass.z],
                          "area": f.Area})
        with open(os.path.join(outdir, name + ".freecad.json"), "w") as fh:
            json.dump({"name": name, "faces": faces, "bbox_diag": shape.BoundBox.DiagonalLength}, fh)
        manifest.append({"name": name, "brep": brep, "faces": len(shape.Faces),
                         "volume": shape.Volume})
    with open(os.path.join(outdir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: make_test_parts.py OUTDIR")
    for row in write_parts(sys.argv[1]):
        print("%-20s faces=%4d volume=%.3f" % (row["name"], row["faces"], row["volume"]))
