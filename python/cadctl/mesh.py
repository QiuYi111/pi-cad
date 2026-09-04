from __future__ import annotations

import math
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


def _vec(value) -> list[float]:
    return [round(float(value.X()), 6), round(float(value.Y()), 6), round(float(value.Z()), 6)]


def _read_step(path: Path):
    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError(f"Unable to read STEP file: {path}")
    reader.TransferRoots()
    return reader.OneShape()


def _children(shape, kind):
    explorer = TopExp_Explorer(shape, kind)
    values = []
    while explorer.More():
        values.append(explorer.Current())
        explorer.Next()
    return values


def _tessellate(shape):
    vertices = []
    triangles = []
    offset = 0
    for raw_face in _children(shape, TopAbs_ShapeEnum.TopAbs_FACE):
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


def mesh_document(path: str | Path) -> dict:
    source = Path(path).resolve()
    shape = _read_step(source)
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    diagonal = math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2)
    tolerance = max(0.05, min(0.75, diagonal / 350))
    solids = _children(shape, TopAbs_ShapeEnum.TopAbs_SOLID) or [shape]
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.22, True).Perform()
    palette = ["#d7d9dc", "#bfc5cc", "#929aa4", "#e6e7e9", "#aab3be", "#cfd4da"]
    parts = []
    for index, solid in enumerate(solids):
        vertices, triangles = _tessellate(solid)
        parts.append({
            "name": f"Solid {index + 1}",
            "positions": [coordinate for vertex in vertices for coordinate in _vec(vertex)],
            "indices": [coordinate for triangle in triangles for coordinate in triangle],
            "color": palette[index % len(palette)],
        })
    return {
        "source": str(source),
        "parts": parts,
        "bounds": {
            "min": [round(xmin, 6), round(ymin, 6), round(zmin, 6)],
            "max": [round(xmax, 6), round(ymax, 6), round(zmax, 6)],
        },
    }
