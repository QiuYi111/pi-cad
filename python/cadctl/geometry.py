from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import build123d as bd


def _wrapped_solids(shape: bd.Shape) -> list[Any]:
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids: list[Any] = []
    explorer = TopExp_Explorer(shape.wrapped, TopAbs_ShapeEnum.TopAbs_SOLID)
    while explorer.More():
        solids.append(TopoDS.Solid_s(explorer.Current()))
        explorer.Next()
    return solids


def _solid_shells(solid: Any) -> list[Any]:
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    shells: list[Any] = []
    explorer = TopExp_Explorer(solid, TopAbs_ShapeEnum.TopAbs_SHELL)
    while explorer.More():
        shells.append(TopoDS.Shell_s(explorer.Current()))
        explorer.Next()
    return shells


def _shell_is_closed(shell: Any) -> bool:
    from OCP.ShapeAnalysis import ShapeAnalysis_Shell

    analyzer = ShapeAnalysis_Shell()
    analyzer.LoadShells(shell)
    analyzer.CheckOrientedShells(shell, True)
    return not bool(analyzer.HasFreeEdges())


def _signed_volume(solid: Any) -> float:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    properties = GProp_GProps()
    # Exact B-Rep calculation. Keeping the sign catches inverted solids.
    BRepGProp.VolumeProperties_s(solid, properties, False, False, False)
    return float(properties.Mass())


def _is_self_intersecting(wrapped: Any) -> bool | None:
    """Return True/False, or None when OpenCascade cannot decide."""
    try:
        from OCP.BOPAlgo import BOPAlgo_CheckStatus
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Check

        checker = BRepAlgoAPI_Check(wrapped, True, True)
        checker.Perform()
        if checker.IsValid():
            return False
        return any(
            result.GetCheckStatus() == BOPAlgo_CheckStatus.BOPAlgo_SelfIntersect
            for result in checker.Result()
        )
    except Exception:
        # Unknown is deliberately not reported as a pass.
        return None


def _validity(shape: bd.Shape) -> dict[str, Any]:
    """Objective B-Rep health only; no dimensions or design intent."""
    from OCP.BRepCheck import BRepCheck_Analyzer

    topology_valid = bool(BRepCheck_Analyzer(shape.wrapped, True).IsValid())
    solids: list[dict[str, Any]] = []
    for index, solid in enumerate(_wrapped_solids(shape)):
        solid_topology = bool(BRepCheck_Analyzer(solid, True).IsValid())
        shells = _solid_shells(solid)
        closed_shells = bool(shells) and all(_shell_is_closed(shell) for shell in shells)
        signed_volume = _signed_volume(solid)
        positive_volume = signed_volume > 0
        self_intersecting = _is_self_intersecting(solid)
        reasons = [
            reason
            for failed, reason in (
                (not solid_topology, "invalidTopology"),
                (not closed_shells, "openShell"),
                (not positive_volume, "nonPositiveVolume"),
                (self_intersecting is True, "selfIntersecting"),
            )
            if failed
        ]
        solids.append(
            {
                "solidIndex": index,
                "topologyValid": solid_topology,
                "closedShells": closed_shells,
                "signedVolume": round(signed_volume, 6),
                "positiveVolume": positive_volume,
                "selfIntersecting": self_intersecting,
                "reasons": reasons,
            }
        )

    reasons: list[str] = []
    if not topology_valid:
        reasons.append("invalidTopology")
    if not solids:
        reasons.append("noSolid")
    failures = sum(bool(solid["reasons"]) for solid in solids) + (1 if not solids else 0)
    closed_shells = bool(solids) and all(bool(solid["closedShells"]) for solid in solids)
    positive_volume = bool(solids) and all(bool(solid["positiveVolume"]) for solid in solids)
    self_intersection_free: bool | None
    if any(solid["selfIntersecting"] is True for solid in solids):
        self_intersection_free = False
    elif solids and all(solid["selfIntersecting"] is False for solid in solids):
        self_intersection_free = True
    else:
        self_intersection_free = None
    return {
        "ok": topology_valid and failures == 0,
        "failureCount": failures,
        "reasons": reasons,
        "checks": {
            "topology": topology_valid,
            "closedShells": closed_shells,
            "positiveVolume": positive_volume,
            "selfIntersectionFree": self_intersection_free,
        },
        "solids": solids,
    }


def _vec(v: bd.Vector) -> list[float]:
    return [round(float(v.X), 6), round(float(v.Y), 6), round(float(v.Z), 6)]


def _axis(ax: bd.Axis) -> dict[str, Any]:
    return {
        "position": _vec(ax.position),
        "direction": _vec(ax.direction),
    }


def _face_selector(shape: bd.Shape, token: str) -> bd.Face:
    token = token.strip().lower()
    if not token.startswith("#"):
        raise ValueError(f"selectors must look like #p0, #c0 or #f0; got {token!r}")
    code = token[1:]
    if code[0] in ("p", "c"):
        prefix = code[0]
        index = int(code[1:])
        target_type = "PLANE" if prefix == "p" else "CYLINDER"
        seen = 0
        for face in shape.faces():
            if str(face.geom_type.name) == target_type:
                if seen == index:
                    return face
                seen += 1
        raise ValueError(f"no {target_type} face for selector {token}")
    if code[0] == "f":
        faces = shape.faces()
        index = int(code[1:])
        if index >= len(faces):
            raise ValueError(f"face index out of range for selector {token}")
        return faces[index]
    raise ValueError(f"unsupported face selector {token}")


def _edge_selector(shape: bd.Shape, token: str) -> bd.Edge:
    token = token.strip().lower()
    if not token.startswith("#e"):
        raise ValueError(f"edge selectors must look like #e0; got {token!r}")
    edges = shape.edges()
    index = int(token[2:])
    if index >= len(edges):
        raise ValueError(f"edge index out of range for selector {token}")
    return edges[index]


def _solid_selector(shape: bd.Shape, token: str) -> bd.Solid:
    token = token.strip().lower()
    if not token.startswith("#s"):
        raise ValueError(f"solid selectors must look like #s0; got {token!r}")
    solids = shape.solids()
    index = int(token[2:])
    if index >= len(solids):
        raise ValueError(f"solid index out of range for selector {token}")
    return solids[index]


def inspect_geometry(artifact: str | Path) -> dict[str, Any]:
    artifact = Path(artifact)
    shape = bd.import_step(artifact)

    bb = shape.bounding_box()
    size = bb.size
    planes: list[dict[str, Any]] = []
    cylinders: list[dict[str, Any]] = []

    for face in shape.faces():
        geom = str(face.geom_type.name)
        if geom == "PLANE":
            center = face.center()
            normal = face.normal_at(center)
            planes.append(
                {
                    "label": f"#p{len(planes)}",
                    "center": _vec(center),
                    "normal": _vec(normal),
                    "area": round(float(face.area), 6),
                }
            )
        elif geom == "CYLINDER":
            axis = face.axis_of_rotation
            center = face.center()
            cylinders.append(
                {
                    "label": f"#c{len(cylinders)}",
                    "center": _vec(center),
                    "axis": _axis(axis),
                    "radius": round(float(face.radius), 6),
                    "area": round(float(face.area), 6),
                }
            )

    solids = shape.solids()
    labels = [shape.label] if getattr(shape, "label", "") else []
    return {
        "units": "mm",
        "bbox": {
            "x": round(float(size.X), 6),
            "y": round(float(size.Y), 6),
            "z": round(float(size.Z), 6),
        },
        "bboxMin": _vec(bb.min),
        "bboxMax": _vec(bb.max),
        "volume": round(float(shape.volume), 6),
        "surfaceArea": round(float(shape.area), 6),
        "solidCount": len(solids),
        "validity": _validity(shape),
        "occurrenceCount": max(len(solids), 1),
        "occurrences": [
            {
                "label": getattr(solid, "label", "") or f"solid-{index}",
                "solidIndex": index,
                "bbox": {
                    "x": round(float(solid.bounding_box().size.X), 6),
                    "y": round(float(solid.bounding_box().size.Y), 6),
                    "z": round(float(solid.bounding_box().size.Z), 6),
                },
            }
            for index, solid in enumerate(solids)
        ],
        "labels": labels,
        "planes": planes,
        "cylinders": cylinders,
    }


def _axis_distance(a: bd.Face, b: bd.Face) -> float:
    ax_a = a.axis_of_rotation
    ax_b = b.axis_of_rotation
    p1 = ax_a.position
    p2 = ax_b.position
    d1 = ax_a.direction
    d2 = ax_b.direction
    r = p2 - p1

    def dot(u: bd.Vector, v: bd.Vector) -> float:
        return u.X * v.X + u.Y * v.Y + u.Z * v.Z

    def cross(u: bd.Vector, v: bd.Vector) -> bd.Vector:
        return bd.Vector(
            u.Y * v.Z - u.Z * v.Y,
            u.Z * v.X - u.X * v.Z,
            u.X * v.Y - u.Y * v.X,
        )

    denom = (cross(d1, d2)).length
    if denom > 1e-12:
        numerator = abs(dot(r, cross(d1, d2)))
        return numerator / denom
    # Parallel axes: perpendicular component of the axis offset.
    if d1.length < 1e-12 or d2.length < 1e-12:
        return r.length
    parallel_component = abs(dot(r, d1))
    return math.sqrt(max(r.length**2 - parallel_component**2, 0.0))


def measure(
    artifact: str | Path,
    metric: str,
    a: str,
    b: str | None = None,
) -> dict[str, Any]:
    artifact = Path(artifact)
    shape = bd.import_step(artifact)

    def face(token: str) -> bd.Face:
        if token.strip().lower().startswith("surf-"):
            from .simulation.surface_selector import resolve_surface_shapes

            return resolve_surface_shapes(artifact, [token.strip().lower()])[token.strip().lower()]
        return _face_selector(shape, token)

    detail: dict[str, Any] = {}
    if metric in {"radius", "diameter"}:
        f = face(a)
        if str(f.geom_type.name) != "CYLINDER":
            raise ValueError(f"{metric} requires a cylindrical face selector")
        radius = float(f.radius)
        value = radius if metric == "radius" else radius * 2.0
        detail = {"radius": radius, "axis": _axis(f.axis_of_rotation)}

    elif metric == "area":
        value = float(face(a).area)

    elif metric == "volume":
        value = float(_solid_selector(shape, a).volume)

    elif metric in {"distance", "clearance", "alignment_delta"}:
        if b is None:
            raise ValueError(f"{metric} requires both a and b selectors")
        fa = face(a)
        fb = face(b)
        if (
            metric in {"distance", "alignment_delta"}
            and str(fa.geom_type.name) == "CYLINDER"
            and str(fb.geom_type.name) == "CYLINDER"
        ):
            axis_distance = _axis_distance(fa, fb)
            if metric == "distance":
                value = axis_distance
            else:
                angle = math.degrees(
                    math.acos(
                        max(
                            -1.0,
                            min(
                                1.0,
                                fa.axis_of_rotation.direction.getAngle(
                                    fb.axis_of_rotation.direction
                                ),
                            ),
                        )
                    )
                )
                value = angle
        else:
            value = float(fa.distance_to(fb))
        detail = {
            "a": {"label": a, "center": _vec(fa.center())},
            "b": {"label": b, "center": _vec(fb.center())},
        }

    elif metric in {"bbox", "frame"}:
        f = face(a)
        bb = f.bounding_box()
        if metric == "bbox":
            value = {
                "x": round(float(bb.size.X), 6),
                "y": round(float(bb.size.Y), 6),
                "z": round(float(bb.size.Z), 6),
            }
        else:
            value = {
                "center": _vec(f.center()),
                "bboxMin": _vec(bb.min),
                "bboxMax": _vec(bb.max),
            }
            if str(f.geom_type.name) == "CYLINDER":
                value["axis"] = _axis(f.axis_of_rotation)
                value["radius"] = round(float(f.radius), 6)
            else:
                value["normal"] = _vec(f.normal_at(f.center()))
    else:
        raise ValueError(f"unsupported metric: {metric}")

    return {
        "units": "mm",
        "metric": metric,
        "a": a,
        "b": b,
        "value": value,
        "detail": detail,
    }
