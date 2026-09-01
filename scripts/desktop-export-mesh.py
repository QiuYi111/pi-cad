#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_Orientation, TopAbs_ShapeEnum
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS


def vec(value):
    return [round(float(value.X()), 6), round(float(value.Y()), 6), round(float(value.Z()), 6)]


def read_step(path: Path):
    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError(f"Unable to read STEP file: {path}")
    reader.TransferRoots()
    return reader.OneShape()


def children(shape, kind):
    explorer = TopExp_Explorer(shape, kind)
    values = []
    while explorer.More():
        values.append(explorer.Current())
        explorer.Next()
    return values


def tessellate(shape):
    vertices = []
    triangles = []
    offset = 0
    for raw_face in children(shape, TopAbs_ShapeEnum.TopAbs_FACE):
        face = TopoDS.Face_s(raw_face)
        location = TopLoc_Location()
        polygon = BRep_Tool.Triangulation_s(face, location)
        if polygon is None:
            continue
        transform = location.Transformation()
        reverse = face.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        vertices.extend(polygon.Node(index).Transformed(transform) for index in range(1, polygon.NbNodes() + 1))
        for triangle in polygon.Triangles():
            a, b, c = (triangle.Value(index) + offset - 1 for index in range(1, 4))
            triangles.append((a, c, b) if reverse else (a, b, c))
        offset += polygon.NbNodes()
    return vertices, triangles


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: desktop-export-mesh.py model.step")
    path = Path(sys.argv[1]).resolve()
    shape = read_step(path)
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    diagonal = math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2)
    # Desktop preview mesh: preserve small-part detail while bounding large curved models.
    tolerance = max(0.05, min(0.75, diagonal / 350))
    solids = children(shape, TopAbs_ShapeEnum.TopAbs_SOLID) or [shape]
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.22, True).Perform()
    palette = ["#d7d9dc", "#bfc5cc", "#929aa4", "#e6e7e9", "#aab3be", "#cfd4da"]
    parts = []
    for index, solid in enumerate(solids):
        vertices, triangles = tessellate(solid)
        parts.append({
            "name": f"Solid {index + 1}",
            "positions": [coordinate for vertex in vertices for coordinate in vec(vertex)],
            "indices": [coordinate for triangle in triangles for coordinate in triangle],
            "color": palette[index % len(palette)],
        })
    payload = {
        "source": str(path),
        "parts": parts,
        "bounds": {
            "min": [round(xmin, 6), round(ymin, 6), round(zmin, 6)],
            "max": [round(xmax, 6), round(ymax, 6), round(zmax, 6)],
        },
    }
    json.dump(payload, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
