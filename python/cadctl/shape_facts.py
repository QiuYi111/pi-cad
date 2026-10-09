"""Neutral shape-fact helpers shared by identity, simulation, render and mesh.

Everything here reads an exact B-Rep (build123d/OCP) and returns geometric
facts, hash-bound surface IDs, or a triangulation. Nothing here decides
engineering meaning. The module imports no other cadctl package at module
level, so identity can enumerate faces without going through simulation or
rendering, which keeps identity -> simulation -> render -> mesh -> identity
from forming.
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

import numpy as np

from .common import sha256_file


def _vec(values: Any, digits: int = 9) -> list[float]:
    if hasattr(values, "X"):
        values = (values.X, values.Y, values.Z)
    return [round(float(values[0]), digits), round(float(values[1]), digits), round(float(values[2]), digits)]


def surface_id(
    artifact_hash: str,
    area: float,
    bbox: list[list[float]],
    *,
    scope: str = "",
) -> str:
    """Deterministic selector ID for one face of one artifact version.

    Rounded to 9 significant decimals so tessellation noise cannot flip the
    ID. Identity uses the exact B-Rep area and bounding box, which are
    well-defined for every face type (unlike a curved face's "center",
    which is seam-dependent).
    """
    identity = (
        f"{artifact_hash}:{scope}:"
        f"a={float(area):.9g}:"
        f"b=[{float(bbox[0][0]):.9g},{float(bbox[0][1]):.9g},{float(bbox[0][2]):.9g}"
        f"|{float(bbox[1][0]):.9g},{float(bbox[1][1]):.9g},{float(bbox[1][2]):.9g}]"
    )
    return "surf-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:10]


def _face_facts(face: Any) -> dict[str, Any]:
    """Exact B-Rep facts for one face.

    Areas, bounding boxes, normals, and axes are exact. The ``centroid`` is
    the face's parametric center (build123d ``Face.center()``): the exact
    area center of mass for planar faces, and the midpoint of the
    parameter range for curved faces. Both are deterministic functions of
    the artifact bytes, which is what the surface ID requires.
    """
    center = face.center()
    geom = str(face.geom_type.name)
    bb = face.bounding_box()
    bbox = [
        [float(bb.min.X), float(bb.min.Y), float(bb.min.Z)],
        [float(bb.max.X), float(bb.max.Y), float(bb.max.Z)],
    ]
    bbox_center = [round((bbox[0][i] + bbox[1][i]) / 2.0, 9) for i in range(3)]
    facts: dict[str, Any] = {
        "type": geom.lower(),
        "area": float(face.area),
        "centroid": (float(center.X), float(center.Y), float(center.Z)),
        "bbox": bbox,
        "bboxCenter": bbox_center,
    }
    if geom == "PLANE":
        normal = face.normal_at(center)
        facts["normal"] = [float(normal.X), float(normal.Y), float(normal.Z)]
    elif geom in ("CYLINDER", "CONE"):
        axis = face.axis_of_rotation
        facts["axis"] = {
            "position": _vec(axis.position),
            "direction": _vec(axis.direction),
        }
        if geom == "CYLINDER":
            facts["radius"] = float(face.radius)
        else:
            facts["halfAngleDeg"] = round(math.degrees(float(face.semi_angle)), 6)
    return facts


def _enumerate_surface_shapes(
    artifact: str | Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return public facts plus the in-process id-to-face lookup."""
    import build123d as bd

    artifact = Path(artifact)
    artifact_hash = sha256_file(artifact)
    shape = bd.import_step(artifact)
    from .assembly import assembly_tree_from_shape

    occurrence_report = assembly_tree_from_shape(shape, artifact_hash)
    occurrence_refs = {
        int(item["solidIndex"]): str(item["ref"])
        for item in occurrence_report.get("occurrences", [])
        if isinstance(item.get("solidIndex"), int) and isinstance(item.get("ref"), str)
    }

    surfaces: list[dict[str, Any]] = []
    by_id: dict[str, Any] = {}
    solids = list(shape.solids())
    groups = [(f"solid-{index}", index, list(solid.faces())) for index, solid in enumerate(solids)]
    if not groups:
        groups = [("shape", None, list(shape.faces()))]
    for scope, solid_index, faces in groups:
        for face in faces:
            facts = _face_facts(face)
            sid = surface_id(artifact_hash, facts["area"], facts["bbox"], scope=scope)
            if sid in by_id:
                raise ValueError(
                    f"duplicate surface identity inside {scope}; geometry is ambiguous"
                )
            facts["id"] = sid
            facts["solidIndex"] = solid_index
            facts["occurrenceRef"] = occurrence_refs.get(solid_index if solid_index is not None else 0)
            facts["area"] = round(facts["area"], 9)
            facts["centroid"] = _vec(facts["centroid"])
            surfaces.append(facts)
            by_id[sid] = face

    ids = [s["id"] for s in surfaces]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate surface IDs derived from geometrically identical faces")

    report = {
        "units": "mm",
        "artifactHash": artifact_hash,
        "solidCount": len(solids),
        "surfaceCount": len(surfaces),
        "surfaces": surfaces,
    }
    return report, by_id


def enumerate_surfaces(artifact: str | Path) -> dict[str, Any]:
    """Enumerate hash-bound boundary-surface facts for any STEP artifact."""
    report, _ = _enumerate_surface_shapes(artifact)
    return report


def _tessellate(shape: Any, tolerance: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    offset = 0
    solids = shape.solids()
    if len(solids) == 0:
        # A single shell/face-only STEP is still renderable.
        solids = [shape]
    for solid in solids:
        verts, tris = solid.tessellate(tolerance, 0.2)
        vertices.extend((float(v.X), float(v.Y), float(v.Z)) for v in verts)
        triangles.extend((a + offset, b + offset, c + offset) for a, b, c in tris)
        offset += len(verts)
    if not vertices or not triangles:
        raise ValueError("STEP contains no tessellatable geometry")
    pts = np.asarray(vertices, dtype=np.float64)
    tri = np.asarray(triangles, dtype=np.int64)
    normals = np.cross(pts[tri[:, 1]] - pts[tri[:, 0]], pts[tri[:, 2]] - pts[tri[:, 0]])
    norms = np.linalg.norm(normals, axis=1)
    valid = norms > 1e-12
    pts = pts
    tri = tri[valid]
    normals = normals[valid] / norms[valid, None]
    return pts, tri, normals
