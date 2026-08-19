"""Deterministic boundary-surface facts and current-artifact-scoped surface IDs.

This module is the geometry half of the thermal/fluid interpreter vocabulary:

* ``inspect_surfaces`` enumerates every boundary face of a STEP artifact and
  returns *facts only* (type, area, centroid, bbox, normal/axis). It never
  decides which face is an inlet, outlet, wall, thermal boundary, or any
  other engineering meaning. That decision belongs to the Agent.
* ``surface_id`` derives a stable selector for one face. The ID is a pure
  function of the artifact bytes plus the face's geometric identity, so the
  same STEP always yields the same IDs, and any geometry change naturally
  invalidates previous selectors (matching the evidence model, where a new
  candidate hash stales previous evidence).

The same enumeration is reused at solve time to name gmsh physical groups,
which is what binds ``boundaries[].surfaces[]`` to SU2 markers.
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

_MAX_VIEW_LABELS = 64


def _hash_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _vec(values: Any, digits: int = 9) -> list[float]:
    if hasattr(values, "X"):
        values = (values.X, values.Y, values.Z)
    return [round(float(values[0]), digits), round(float(values[1]), digits), round(float(values[2]), digits)]


def surface_id(artifact_hash: str, area: float, bbox: list[list[float]]) -> str:
    """Deterministic selector ID for one face of one artifact version.

    Rounded to 9 significant decimals so tessellation noise cannot flip the
    ID. Identity uses the exact B-Rep area and bounding box, which are
    well-defined for every face type (unlike a curved face's "center",
    which is seam-dependent).
    """
    identity = (
        f"{artifact_hash}:"
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


def enumerate_surfaces(artifact: str | Path) -> dict[str, Any]:
    """Enumerate deterministic boundary-surface facts for a STEP artifact."""
    import build123d as bd

    artifact = Path(artifact)
    artifact_hash = _hash_file(artifact)
    shape = bd.import_step(artifact)

    solids = shape.solids()
    if len(solids) != 1:
        raise ValueError(
            f"surface inspection expects exactly one solid in V1; {artifact.name} has {len(solids)}"
        )

    surfaces: list[dict[str, Any]] = []
    for face in shape.faces():
        facts = _face_facts(face)
        facts["id"] = surface_id(artifact_hash, facts["area"], facts["bbox"])
        facts["area"] = round(facts["area"], 9)
        facts["centroid"] = _vec(facts["centroid"])
        surfaces.append(facts)

    ids = [s["id"] for s in surfaces]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate surface IDs derived from geometrically identical faces")

    return {
        "units": "mm",
        "artifactHash": artifact_hash,
        "surfaceCount": len(surfaces),
        "surfaces": surfaces,
    }


def resolve_surface_ids(
    artifact: str | Path,
    requested: list[str],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Validate that ``requested`` surface IDs exist on this artifact version.

    Returns (id -> facts, report). Unknown IDs fail closed with the list of
    valid IDs so the caller can re-inspect instead of guessing.
    """
    report = enumerate_surfaces(artifact)
    by_id = {s["id"]: s for s in report["surfaces"]}
    unknown = [sid for sid in requested if sid not in by_id]
    if unknown:
        raise ValueError(
            f"unknown surface IDs {unknown} for this artifact version; valid IDs are {sorted(by_id)}"
        )
    return {sid: by_id[sid] for sid in requested}, report


def _project(point: Any, camera: dict[str, tuple[float, float, float]], width: int, height: int,
             bbox_min: Any, bbox_max: Any) -> tuple[int, int]:
    right = camera["right"]
    up = camera["up"]
    px = point[0] * right[0] + point[1] * right[1] + point[2] * right[2]
    py = point[0] * up[0] + point[1] * up[1] + point[2] * up[2]
    span_right = [
        bbox_min[0] * right[0] + bbox_min[1] * right[1] + bbox_min[2] * right[2],
        bbox_max[0] * right[0] + bbox_max[1] * right[1] + bbox_max[2] * right[2],
    ]
    span_up = [
        bbox_min[0] * up[0] + bbox_min[1] * up[1] + bbox_min[2] * up[2],
        bbox_max[0] * up[0] + bbox_max[1] * up[1] + bbox_max[2] * up[2],
    ]
    min_r, max_r = min(span_right), max(span_right)
    min_u, max_u = min(span_up), max(span_up)
    scale = min(
        (width - 2 * 40) / max(max_r - min_r, 1e-9),
        (height - 2 * 60) / max(max_u - min_u, 1e-9),
    )
    x = int((px - (min_r + max_r) / 2.0) * scale + width / 2.0)
    y = int(height - ((py - (min_u + max_u) / 2.0) * scale + height / 2.0))
    return x, y


_VIEW_CAMERAS: dict[str, dict[str, tuple[float, float, float]]] = {
    "iso": {"right": (-1.0, 1.0, 0.0), "up": (1.0, 1.0, 2.0)},
    "front": {"right": (1.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "right": {"right": (0.0, -1.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "top": {"right": (1.0, 0.0, 0.0), "up": (0.0, -1.0, 0.0)},
}

# Deterministic palette cycled per surface index.
_PALETTE = [
    (198, 63, 63), (63, 140, 198), (96, 168, 96), (190, 148, 62),
    (150, 106, 187), (63, 178, 170), (187, 96, 138), (118, 128, 184),
]


def render_labeled_views(
    artifact: str | Path,
    out_dir: str | Path,
    surfaces: list[dict[str, Any]],
    views: list[str] | None = None,
    width: int = 760,
    height: int = 560,
) -> list[dict[str, Any]]:
    """Render orthographic views with each surface tinted and labeled by its ID.

    Purely observational: the label is the geometric selector, never a
    semantic name.
    """
    import numpy as np
    from PIL import Image, ImageDraw

    import build123d as bd
    from ..render import _tessellate

    artifact = Path(artifact)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    shape = bd.import_step(artifact)
    bb = shape.bounding_box()
    diagonal = math.sqrt(
        (bb.max.X - bb.min.X) ** 2 + (bb.max.Y - bb.min.Y) ** 2 + (bb.max.Z - bb.min.Z) ** 2
    )
    pts, tri, _normals = _tessellate(shape, max(diagonal * 0.0025, 0.05))

    # Color triangles by which labeled surface they tessellate from: assign
    # each triangle to the surface whose centroid is nearest the triangle
    # centroid (tessellations come from the same B-Rep, so this is exact
    # in practice and only decides the tint).
    centroids = np.asarray([s["centroid"] for s in surfaces], dtype=np.float64)
    tri_pts = pts[tri]
    tri_centers = tri_pts.mean(axis=1)
    dists = np.linalg.norm(tri_centers[:, None, :] - centroids[None, :, :], axis=2)
    nearest = np.argmin(dists, axis=1)

    base = np.asarray((212, 216, 222), dtype=np.float64)
    colors = np.asarray(_PALETTE, dtype=np.float64)
    shade = 0.75 + 0.25 * np.abs(
        np.cross(tri_pts[:, 1] - tri_pts[:, 0], tri_pts[:, 2] - tri_pts[:, 0])
    ) / np.linalg.norm(
        np.cross(tri_pts[:, 1] - tri_pts[:, 0], tri_pts[:, 2] - tri_pts[:, 0]), axis=1, keepdims=True
    ).clip(1e-12) @ np.asarray((0.45, 0.35, 0.82))
    tri_colors = base[None, :] + (colors[nearest] - base[None, :]) * 0.85
    tri_colors = np.clip(tri_colors * shade[:, None], 0, 255)

    selected = list(views) if views else ["iso", "front", "right", "top"]
    for view in selected:
        if view not in _VIEW_CAMERAS:
            raise ValueError(f"unsupported surface view: {view}")

    bbox_min = (bb.min.X, bb.min.Y, bb.min.Z)
    bbox_max = (bb.max.X, bb.max.Y, bb.max.Z)
    rendered: list[dict[str, Any]] = []
    for view in selected:
        camera = _VIEW_CAMERAS[view]
        image = Image.new("RGB", (width, height), (255, 255, 255))
        draw = ImageDraw.Draw(image)
        forward = (
            -camera["up"][0] * camera["right"][1] + camera["up"][1] * camera["right"][0],
            -camera["up"][2] * camera["right"][0] + camera["up"][0] * camera["right"][2],
            -camera["up"][1] * camera["right"][2] + camera["up"][2] * camera["right"][1],
        )
        f = np.asarray(forward, dtype=np.float64)
        right = np.asarray(camera["right"], dtype=np.float64)
        up = np.asarray(camera["up"], dtype=np.float64)
        px = pts @ right
        py = pts @ up
        pz = pts @ f
        margin_x, margin_y = 40, 60
        scale = min(
            (width - 2 * margin_x) / max(px.max() - px.min(), 1e-9),
            (height - 2 * margin_y) / max(py.max() - py.min(), 1e-9),
        )
        sx = (px - (px.max() + px.min()) / 2) * scale + width / 2
        sy = height - ((py - (py.max() + py.min()) / 2) * scale + height / 2)

        # Painter's algorithm: far-to-near triangle sort along the view axis.
        depth = pz[tri].mean(axis=1)
        order = np.argsort(depth)

        for i in order:
            a, b, c = tri[i]
            draw.polygon(
                [(sx[a], sy[a]), (sx[b], sy[b]), (sx[c], sy[c])],
                fill=tuple(int(v) for v in tri_colors[i]),
                outline=(70, 74, 80),
            )

        for index, surface in enumerate(surfaces[:_MAX_VIEW_LABELS]):
            x, y = _project(surface["centroid"], camera, width, height, bbox_min, bbox_max)
            label = surface["id"]
            lx, ly = x - 18, y - 9
            draw.rectangle((lx - 3, ly - 3, lx + 8 * len(label) + 1, ly + 13), fill=(255, 255, 255))
            draw.text((lx, ly), label, fill=tuple(int(v) for v in colors[index % len(colors)]))
        draw.rectangle((0, 0, width - 1, 21), fill=(245, 245, 245))
        draw.text((6, 4), f"{view.upper()} - {len(surfaces)} surfaces (selectors, not semantics)", fill=(20, 20, 20))

        path = out_dir / f"surfaces-{view}.png"
        image.save(path)
        rendered.append(
            {
                "name": view,
                "path": str(path),
                "camera": {k: list(v) for k, v in camera.items()},
                "width": width,
                "height": height,
                "labeledSurfaces": min(len(surfaces), _MAX_VIEW_LABELS),
            }
        )
    return rendered
