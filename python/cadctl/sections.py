"""Section analytics interpreter (0.8 M4c, whitepaper section 12).

Deterministic scan of cross-section facts along an axis or explicit path:
area, centroid, second moments, principal moments, bbox, loop count.

Sections are explicit sensors: the interpreter reports facts, never a
"critical section" judgment — that is engineering interpretation and
belongs to the Agent.
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any

import build123d as bd

_AXES = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}


def _plane_for(axis: str, position: float) -> bd.Plane:
    direction = _AXES[axis]
    origin = tuple(position * component for component in direction)
    return bd.Plane(origin=bd.Vector(*origin), z_dir=bd.Vector(*direction))


def _bounds_along(shape: bd.Shape, axis: str) -> tuple[float, float]:
    box = shape.bounding_box()
    lo = getattr(box.min, axis.upper())
    hi = getattr(box.max, axis.upper())
    return float(lo), float(hi)


def _section_facts(face: bd.Face, axis: str, position: float) -> dict[str, Any] | None:
    area = float(face.area)
    if area <= 1e-12:
        return None
    center = face.center()
    # Coordinates in the section plane: the two axes other than the scan
    # axis, named u/v deterministically (u before v in x<y<z order).
    others = [a for a in ("x", "y", "z") if a != axis]
    u_name, v_name = others[0], others[1]
    center_u = getattr(center, u_name.upper())
    center_v = getattr(center, v_name.upper())

    # Second moments via boundary-quadrature-free exact properties:
    # build a planar sketch face in u,v and read its moments. OCCT surface
    # of inertia gives volume-equivalent moments for planar faces directly.
    props = face.to_pln() if hasattr(face, "to_pln") else None
    # Fall back to mesh-free computation: moment properties of the planar
    # face computed in its own plane coordinate system.
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    surface_props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face.wrapped, surface_props)
    com = surface_props.CentreOfMass()
    inertia = surface_props.MatrixOfInertia()
    # MatrixOfInertia for a planar face returns mass = area and moments
    # about the origin; extract the planar components.
    iu = inertia.Value(1, 1)  # about u axis through origin
    iv = inertia.Value(2, 2)  # about v axis through origin
    iuv = -inertia.Value(1, 2)  # product of inertia (sign convention)
    # Reinterpret in the section plane: axes 1,2 are in-plane, so moments
    # about the plane's origin of the GLOBAL system; shift to centroid.
    u_c = float(com.X())
    v_c = float(com.Y())
    # For planar faces OCCT reports in the face's own coordinate system.
    iu_c = float(iu) - area * v_c * v_c
    iv_c = float(iv) - area * u_c * u_c
    iuv_c = float(iuv) + area * u_c * v_c

    # Principal moments in the section plane.
    mean = (iu_c + iv_c) / 2
    radius = math.sqrt(max(((iu_c - iv_c) / 2) ** 2 + iuv_c**2, 0.0))
    i1 = mean + radius
    i2 = mean - radius
    if abs(iuv_c) < 1e-15 and abs(iu_c - iv_c) < 1e-15:
        theta = 0.0
    else:
        theta = 0.5 * math.atan2(2 * iuv_c, iu_c - iv_c)

    loops = len(face.wires() if hasattr(face, "wires") else [])
    bb = face.bounding_box()
    return {
        "area": round(area, 9),
        "centroid": {
            u_name: round(center_u, 6),
            v_name: round(center_v, 6),
            axis: round(position, 6),
        },
        "Iu": round(iu_c, 9),
        "Iv": round(iv_c, 9),
        "Iuv": round(iuv_c, 9),
        "principalMoments": [round(i1, 9), round(i2, 9)],
        "principalAngleRad": round(theta, 9),
        "bbox": {
            u_name: [round(float(bb.min.X if u_name != "z" else bb.min.Z), 6), round(float(bb.max.X if u_name != "z" else bb.max.Z), 6)],
            v_name: [round(float(bb.min.Y if v_name != "z" else bb.max.Y), 6), round(float(bb.max.Y if v_name != "z" else bb.max.Y), 6)],
        },
        "loopCount": loops,
    }


def scan_sections(
    artifact: str | Path,
    axis: str = "z",
    count: int | None = None,
    step: float | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    if axis not in _AXES:
        raise ValueError(f"axis must be one of x, y, z; got {axis!r}")
    if (count is None) == (step is None):
        raise ValueError("provide exactly one of count or step")
    if count is not None and count < 1:
        raise ValueError("count must be >= 1")
    if step is not None and step <= 0:
        raise ValueError("step must be > 0")

    artifact = Path(artifact)
    shape = bd.import_step(artifact)
    lo, hi = _bounds_along(shape, axis)
    span = hi - lo

    positions: list[float] = []
    if count is not None:
        if count == 1:
            positions = [(lo + hi) / 2]
        else:
            positions = [lo + span * index / (count - 1) for index in range(count)]
    else:
        current = lo
        while current <= hi + 1e-9:
            positions.append(current)
            current += float(step)

    sections: list[dict[str, Any]] = []
    for position in positions:
        plane = _plane_for(axis, position)
        intersections = shape.intersect(plane)
        faces = [item for item in intersections if isinstance(item, bd.Face)] if intersections else []
        facts: list[dict[str, Any]] = []
        total_area = 0.0
        for face in faces:
            fact = _section_facts(face, axis, position)
            if fact:
                facts.append(fact)
                total_area += fact["area"]
        sections.append(
            {
                "position": round(position, 6),
                "faceCount": len(facts),
                "totalArea": round(total_area, 9),
                "faces": facts,
            }
        )

    areas = [section["totalArea"] for section in sections]
    return {
        "units": "mm",
        "axis": axis,
        "bounds": [round(lo, 6), round(hi, 6)],
        "positionCount": len(sections),
        "sections": sections,
        "areaRange": [round(min(areas), 9), round(max(areas), 9)] if areas else [0.0, 0.0],
        "notes": [
            "facts only: area, centroid, second moments (in-plane), principal moments, loop count",
            "which section is critical is an engineering judgment, not a tool output",
        ],
        "durationMs": int((time.monotonic() - started) * 1000),
    }
