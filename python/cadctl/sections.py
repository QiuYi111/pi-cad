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
    """Exact planar-section facts, computed in an explicit (u, v, n) basis.

    For scan axis n, the in-plane coordinates are the other two axes in
    x < y < z order (u before v). The OCCT surface-inertia matrix is
    global, so the raw second moments are recovered by solving the
    planar-face relations (one coordinate is constant on the face) and
    then projected onto (u, v). The 0.8-review bug — reading Value(1,1)/
    Value(2,2) as if the face-local frame were always global XY — made
    every x/y-axis section wrong; this version is axis-symmetric.
    """
    area = float(face.area)
    if area <= 1e-12:
        return None
    center = face.center()
    others = [a for a in ("x", "y", "z") if a != axis]
    u_name, v_name = others[0], others[1]

    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    surface_props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face.wrapped, surface_props)
    com = surface_props.CentreOfMass()
    inertia = surface_props.MatrixOfInertia()
    # Global second-moment raw integrals. For a planar face with the scan
    # coordinate constant: M11 = Iyy + Izz, M22 = Ixx + Izz,
    # M33 = Ixx + Iyy, and the products carry a minus sign.
    m11, m22, m33 = (float(inertia.Value(i, i)) for i in (1, 2, 3))
    raw_xx = (m22 + m33 - m11) / 2.0
    raw_yy = (m11 + m33 - m22) / 2.0
    raw_xy = -float(inertia.Value(1, 2))

    # Products carry a minus sign in OCCT's matrix; recover all six raw
    # planar integrals once, then look up by axis name.
    raw_zz = (m11 + m22 - m33) / 2.0
    raw_by_name = {
        "xx": raw_xx,
        "yy": raw_yy,
        "zz": raw_zz,
        "xy": raw_xy,
        "xz": -float(inertia.Value(1, 3)),
        "yz": -float(inertia.Value(2, 3)),
    }
    raw_u2 = raw_by_name[u_name + u_name]
    raw_v2 = raw_by_name[v_name + v_name]
    raw_uv = raw_by_name[u_name + v_name]

    component = {"x": float(com.X()), "y": float(com.Y()), "z": float(com.Z())}
    cu = component[u_name]
    cv = component[v_name]

    # Iu = moment about the u axis = ∫v²dA; Iv = ∫u²dA; Iuv = ∫u·v·dA.
    # Shift to the centroid with the parallel-axis theorem.
    iu_c = raw_v2 - area * cv * cv
    iv_c = raw_u2 - area * cu * cu
    iuv_c = raw_uv - area * cu * cv

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
    bounds = {
        "x": [float(bb.min.X), float(bb.max.X)],
        "y": [float(bb.min.Y), float(bb.max.Y)],
        "z": [float(bb.min.Z), float(bb.max.Z)],
    }
    return {
        "area": round(area, 9),
        "centroid": {
            u_name: round(cu, 6),
            v_name: round(cv, 6),
            axis: round(position, 6),
        },
        "Iu": round(iu_c, 9),
        "Iv": round(iv_c, 9),
        "Iuv": round(iuv_c, 9),
        "principalMoments": [round(i1, 9), round(i2, 9)],
        "principalAngleRad": round(theta, 9),
        "bbox": {
            u_name: [round(bounds[u_name][0], 6), round(bounds[u_name][1], 6)],
            v_name: [round(bounds[v_name][0], 6), round(bounds[v_name][1], 6)],
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
