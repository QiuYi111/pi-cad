"""Lint facts: the inputs of the first layer, read from the recomputed document (imports FreeCAD).

Reuses ``transfer`` (sketch frames, sketch geometry, placed shapes, bounding boxes) by import.
Hole properties are read here, not through ``transfer._hole``, because that function refuses
features (modeled threads, for example) that lint must report on.
"""

from __future__ import annotations

import json
from typing import Any

import FreeCAD as App
import Part

from .. import transfer as tr
from .. import transfer_geometry as tg
from ..assembly import BODY, REFERENCE, units
from ..core import body_features, get_path
from .profile import get_profile
from .sketch_metrics import loop_metrics

_DRESSUP = {"PartDesign::Fillet": "fillet", "PartDesign::Chamfer": "chamfer"}


def extract_facts(ctx: Any) -> dict[str, Any]:
    session = ctx.session
    found = units(session)
    bodies_out: list[dict[str, Any]] = []
    boxes: list[Any] = []
    volume = 0.0
    has_tree = True
    for unit in found:
        shape = unit.shape()
        solid = not shape.isNull() and bool(shape.Solids)
        bodies_out.append({"path": unit.path, "imported": unit.kind == REFERENCE, "solid": solid})
        if unit.kind != BODY and solid:
            has_tree = False  # an import or a linked part: its features are not in this document
        if solid:
            boxes.append(tr._bbox(shape))
            volume += shape.Volume
    union = None
    for box in boxes:
        if union is None:
            union = App.BoundBox(box)
        else:
            union.add(box)
    facts: dict[str, Any] = {
        "part": bodies_out[0]["path"] if len(bodies_out) == 1 else session.fcstd.stem,
        "bbox": None, "bbox_min": None, "bbox_max": None,
        "volume_mm3": round(volume, 6),
        "has_feature_tree": has_tree,
        "bodies": bodies_out,
        "holes": [], "pockets": [], "pads": [], "fillets": [], "chamfers": [],
        "sharp_edges": [], "unreadable": [],
        "requirements": _requirements(session),
        "profile": get_profile(session),
    }
    if union is not None:
        facts["bbox"] = [round(union.XLength, 6), round(union.YLength, 6), round(union.ZLength, 6)]
        facts["bbox_min"] = [round(union.XMin, 6), round(union.YMin, 6), round(union.ZMin, 6)]
        facts["bbox_max"] = [round(union.XMax, 6), round(union.YMax, 6), round(union.ZMax, 6)]

    sketches: dict[str, tuple[dict[str, Any], list[list[float]]]] = {}
    for unit in found:
        if unit.kind != BODY:
            continue
        body = unit.obj
        shape = unit.shape()
        if shape.isNull() or not shape.Solids:
            continue
        box = tr._bbox(shape)
        for obj in body_features(body):
            path = get_path(obj)
            if not path:
                continue
            try:
                _feature(obj, path, unit.path, box, sketches, facts)
            except Exception as error:  # noqa: BLE001 - one unreadable feature must not stop the lint
                facts["unreadable"].append({"path": path, "reason": f"{type(error).__name__}: {error}"})
        facts["sharp_edges"].append({"body": unit.path, "count": _sharp_edges(session, unit)})
    return facts


def _requirements(session: Any) -> list[dict[str, Any]]:
    group = session.requirements_group(create=False)
    out = []
    for item in (group.Group if group is not None else []):
        out.append({
            "path": get_path(item) or item.Label, "kind": item.Kind,
            "target": json.loads(item.Target), "limit": json.loads(item.Limit), "tolerance": float(item.Tolerance),
        })
    return out


def _sketch(sketch: Any, cache: dict[str, Any]) -> tuple[dict[str, Any], list[list[float]]]:
    name = get_path(sketch) or sketch.Label
    if name not in cache:
        cache[name] = tr._sketch_entry(sketch, strict=False)
    return cache[name]


def _profile_sketch(obj: Any) -> Any:
    profile = obj.Profile
    sketch = profile[0] if isinstance(profile, (tuple, list)) else profile
    if sketch is None:
        raise ValueError("the feature has no profile sketch")
    return sketch


def _extent(direction: list[float], box: Any) -> float:
    return abs(direction[0]) * box.XLength + abs(direction[1]) * box.YLength + abs(direction[2]) * box.ZLength


def _loops(geometry: list[dict[str, Any]]) -> list[dict[str, Any]]:
    loops = tg.build_loops(geometry, strict=False)
    depths = tg.nesting_depths(geometry, loops)
    by_id = {g["id"]: g for g in geometry}
    out = []
    for loop in loops:
        metrics = loop_metrics({"geometry": [by_id[i] for i in loop["geometry"]], "orient": loop["orient"]})
        out.append({**metrics, "id": loop["id"], "nesting": depths[loop["id"]]})
    return out


def _feature(obj: Any, path: str, body: str, box: Any, sketches: dict[str, Any], facts: dict[str, Any]) -> None:
    tid = obj.TypeId
    if tid == "PartDesign::Hole":
        facts["holes"].append(_hole(obj, path, body, box, sketches))
    elif tid == "PartDesign::Pocket":
        facts["pockets"].append(_pocket(obj, path, body, box, sketches))
    elif tid == "PartDesign::Pad":
        facts["pads"].append(_pad(obj, path, body, box, sketches))
    elif tid in _DRESSUP:
        facts["fillets" if _DRESSUP[tid] == "fillet" else "chamfers"].append(_dressup(obj, path, body, box))


def _hole(obj: Any, path: str, body: str, box: Any, sketches: dict[str, Any]) -> dict[str, Any]:
    entry, positions = _sketch(_profile_sketch(obj), sketches)
    frame = entry["frame"]
    origin, u, v, n = frame["origin"], frame["u"], frame["v"], frame["n"]
    axis = list(n) if obj.Reversed else [-c for c in n]
    through = str(obj.DepthType) == "ThroughAll"
    depth = None if through else float(obj.Depth.Value)
    threaded = bool(obj.Threaded)
    thread_size = str(obj.ThreadSize).partition("x")[0] if threaded else None
    if threaded and str(obj.ThreadDepthType) == "Hole Depth":
        thread_depth = depth if depth is not None else _extent(axis, box)
    elif threaded:
        thread_depth = float(obj.ThreadDepth.Value)
    else:
        thread_depth = None
    world = [[origin[i] + x * u[i] + y * v[i] for i in range(3)] for x, y in positions]
    return {
        "path": path, "body": body, "sketch": get_path(_profile_sketch(obj)),
        "diameter": float(obj.Diameter.Value), "depth": depth, "through": through,
        "length": _extent(axis, box) if through else depth,
        "depth_type": "through" if through else "blind",
        "threaded": threaded, "model_thread": bool(obj.ModelThread), "thread_size": thread_size,
        "thread_depth": thread_depth,
        "cut_type": str(obj.HoleCutType),
        "cut_diameter": float(obj.HoleCutDiameter.Value), "cut_depth": float(obj.HoleCutDepth.Value),
        "countersink_angle": float(obj.HoleCutCountersinkAngle.Value),
        "drill_point": str(obj.DrillPoint).lower(),
        "positions": world, "axis": [round(c, 9) for c in axis],
    }


def _pocket(obj: Any, path: str, body: str, box: Any, sketches: dict[str, Any]) -> dict[str, Any]:
    entry, _ = _sketch(_profile_sketch(obj), sketches)
    n = entry["frame"]["n"]
    axis = list(n) if obj.Reversed else [-c for c in n]
    through = str(obj.Type) == "ThroughAll"
    depth = _extent(axis, box) if through else float(obj.Length.Value)
    return {"path": path, "body": body, "depth": depth, "through": through, "loops": _loops(entry["geometry"])}


def _pad(obj: Any, path: str, body: str, box: Any, sketches: dict[str, Any]) -> dict[str, Any]:
    entry, _ = _sketch(_profile_sketch(obj), sketches)
    return {"path": path, "body": body, "length": float(obj.Length.Value), "loops": _loops(entry["geometry"])}


def _dressup(obj: Any, path: str, body: str, box: Any) -> dict[str, Any]:
    base = getattr(obj, "BaseFeature", None) or obj.Base[0]
    shape = tr._placed(base)
    names = [f"Edge{i + 1}" for i in range(len(shape.Edges))] if obj.UseAllEdges else list(obj.Base[1])
    sides, outer = [], []
    for name in names:
        side, on_outline = _edge_side(shape.getElement(name), box)
        sides.append(side)
        outer.append(on_outline)
    out: dict[str, Any] = {"path": path, "body": body, "sides": sides, "outer": outer}
    if _DRESSUP[obj.TypeId] == "fillet":
        out["radius"] = float(obj.Radius.Value)
    else:
        out["size"] = float(obj.Size.Value)
    return out


def _edge_side(edge: Any, box: Any) -> tuple[str, bool]:
    """(top | bottom | vertical | unknown, lies on the outline of the body) for one world-coordinate edge."""
    tol = 1e-4 * max(box.DiagonalLength, 1.0)
    first, last = edge.FirstParameter, edge.LastParameter
    ends = [edge.valueAt(first), edge.valueAt((first + last) / 2), edge.valueAt(last)]
    on_outline = any(
        abs(p.x - box.XMin) <= tol or abs(p.x - box.XMax) <= tol or abs(p.y - box.YMin) <= tol or abs(p.y - box.YMax) <= tol
        for p in ends
    )
    kind = type(edge.Curve).__name__
    if kind == "Line":
        d = ends[2] - ends[0]
        length = d.Length
        if length < 1e-9:
            return "unknown", on_outline
        if abs(d.z) / length >= 1 - 1e-6:
            return "vertical", on_outline
        if abs(d.z) > 1e-6 * length:
            return "unknown", on_outline
    elif kind == "Circle":
        if abs(edge.Curve.Axis.z) < 1 - 1e-6:
            return "unknown", on_outline
    else:
        return "unknown", on_outline
    z = ends[1].z
    if abs(z - box.ZMax) <= tol:
        return "top", on_outline
    if abs(z - box.ZMin) <= tol:
        return "bottom", on_outline
    return "unknown", on_outline


def _sharp_edges(session: Any, unit: Any) -> int:
    """Convex edges between two planar faces that no fillet or chamfer created (default-chamfer candidates)."""
    local = unit.local_shape()
    if local.isNull():
        return 0
    dressup: list[tuple[Any, float]] = []
    try:
        for key, entries in session.roles(unit.obj).faces.items():
            if key.rsplit("/", 1)[-1].startswith(("round", "bevel")):
                dressup.extend((entry.face.CenterOfMass, entry.face.Area) for entry in entries)
    except Exception:  # noqa: BLE001 - without roles every planar edge is a candidate
        dressup = []

    # one pass over the faces: centre, area and outward normal of each planar face that no feature created
    faces_info: list[tuple[Any, Any] | None] = []
    for face in local.Faces:
        if type(face.Surface).__name__ != "Plane":
            faces_info.append(None)
            continue
        centre, area = face.CenterOfMass, face.Area
        if any(abs(centre.x - c.x) < 1e-4 and abs(centre.y - c.y) < 1e-4 and abs(centre.z - c.z) < 1e-4
               and abs(area - a) < 1e-4 * max(area, 1.0) for c, a in dressup):
            faces_info.append(None)
            continue
        faces_info.append((centre, face.normalAt(*face.Surface.parameter(centre))))

    edge_faces: dict[int, list[int]] = {}
    edge_of: dict[int, Any] = {}
    for index, face in enumerate(local.Faces):
        for edge in face.Edges:
            key = edge.hashCode()
            edge_faces.setdefault(key, []).append(index)
            edge_of.setdefault(key, edge)

    count = 0
    for key, indexes in edge_faces.items():
        if len(indexes) != 2 or any(faces_info[i] is None for i in indexes):
            continue
        (centre_a, normal_a), (centre_b, normal_b) = faces_info[indexes[0]], faces_info[indexes[1]]
        if abs(normal_a.dot(normal_b)) > 1 - 1e-6:
            continue
        if _convex(edge_of[key], [centre_a, centre_b], [normal_a, normal_b]):
            count += 1
    return count


def _convex(edge: Any, centres: list[Any], normals: list[Any]) -> bool:
    """True when the solid is locally on the inner side of both planes at the edge (a convex corner).

    In-face directions e1, e2 point from the edge into each face; the solid lies on the side
    opposite the outward normal, so the edge is convex when e2 points below face 1 (and the
    reverse). No solid query is needed.
    """
    middle = (edge.FirstParameter + edge.LastParameter) / 2
    mid = edge.valueAt(middle)
    tangent = edge.tangentAt(middle)
    tangent = tangent * (1.0 / tangent.Length)
    directions = []
    for centre in centres:
        into = centre - mid
        into = into - tangent * into.dot(tangent)
        directions.append(into * (1.0 / into.Length) if into.Length > 1e-9 else into)
    return directions[1].dot(normals[0]) < -1e-6 and directions[0].dot(normals[1]) < -1e-6
