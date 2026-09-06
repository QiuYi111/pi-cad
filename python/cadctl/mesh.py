from __future__ import annotations

import math
import json
import hashlib
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

from .common import sha256_file


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
    manifest_path = source.with_suffix(source.suffix + ".assembly.json")
    manifest = None
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema") != 1 or not isinstance(manifest.get("parts"), list):
            raise ValueError(f"Invalid assembly identity manifest: {manifest_path}")
    identities = {}
    if manifest:
        for part in manifest["parts"]:
            part_id = str(part.get("id", "")).strip()
            name = str(part.get("name", part_id)).strip()
            indices = part.get("solidIndices", [])
            if not part_id or not isinstance(indices, list):
                raise ValueError(f"Invalid assembly part identity: {manifest_path}")
            for local_index, solid_index in enumerate(indices):
                if not isinstance(solid_index, int) or solid_index < 0 or solid_index >= len(solids) or solid_index in identities:
                    raise ValueError(f"Invalid or duplicate solid index in assembly manifest: {solid_index}")
                identities[solid_index] = (part_id, name, f"{part_id}:solid-{local_index + 1}")
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.22, True).Perform()
    palette = ["#d7d9dc", "#bfc5cc", "#929aa4", "#e6e7e9", "#aab3be", "#cfd4da"]
    parts = []
    geometry_occurrences: dict[str, int] = {}
    for index, solid in enumerate(solids):
        vertices, triangles = _tessellate(solid)
        positions = [coordinate for vertex in vertices for coordinate in _vec(vertex)]
        indices = [coordinate for triangle in triangles for coordinate in triangle]
        if index in identities:
            part_id, name, solid_id = identities[index]
        else:
            geometry = json.dumps(
                {"bounds": _shape_bounds(solid), "positions": positions, "indices": indices},
                separators=(",", ":"),
            )
            digest = hashlib.sha256(geometry.encode("utf-8")).hexdigest()[:16]
            occurrence = geometry_occurrences.get(digest, 0) + 1
            geometry_occurrences[digest] = occurrence
            solid_id = f"geometry:{digest}:{occurrence}"
            part_id, name = solid_id, f"Unbound solid {index + 1}"
        parts.append({
            "id": solid_id,
            "partId": part_id,
            "solidId": solid_id,
            "name": name,
            "positions": positions,
            "indices": indices,
            "color": palette[index % len(palette)],
        })
    return {
        "source": str(source),
        "sha256": sha256_file(source),
        "parts": parts,
        "bounds": {
            "min": [round(xmin, 6), round(ymin, 6), round(zmin, 6)],
            "max": [round(xmax, 6), round(ymax, 6), round(zmax, 6)],
        },
    }


def _shape_bounds(shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box)
    return [round(value, 6) for value in box.Get()]
