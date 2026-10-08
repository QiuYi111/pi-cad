"""Canonical feature JSON (``reify.features/1``) from a recomputed FreeCAD document.

Read only: nothing here changes the document. Contract: docs/cad-transfer/protocol.md section 1.

Verified FreeCAD 1.1 direction conventions (built real parts, compared bounding boxes), with
``n`` the sketch normal from ``getGlobalPlacement()`` (the XZ origin plane has n = -Y):

* Pad adds material along +n; ``Reversed`` flips it to -n; ``Midplane`` is symmetric.
* Pocket removes material along -n (into the material for a sketch on a top face);
  ``Reversed`` flips it to +n.
* Hole (through all) removes material along -n; ``Reversed`` flips it to +n.
* Polar pattern ``Reversed`` negates the rotation direction, i.e. the axis direction.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import FreeCAD as App

from . import transfer_geometry as tg
from .core import bodies, get_path, is_feature, is_sketch
from .errors import ReifyOpError

SCHEMA = "reify.features/1"

_OP_NAMES = {
    "PartDesign::Pad": "pad", "PartDesign::Pocket": "pocket", "PartDesign::Hole": "hole",
    "PartDesign::PolarPattern": "polar_pattern", "PartDesign::LinearPattern": "linear_pattern",
    "PartDesign::Mirrored": "mirror", "PartDesign::MultiTransform": "multi_transform",
    "PartDesign::Fillet": "fillet", "PartDesign::Chamfer": "chamfer", "PartDesign::Revolution": "revolution",
    "PartDesign::Groove": "groove", "PartDesign::Loft": "loft", "PartDesign::Pipe": "sweep",
    "PartDesign::Draft": "draft", "PartDesign::Thickness": "thickness",
}


def _r(x: float) -> float:
    return round(float(x), 9) + 0.0


def _vec(v: Any) -> list[float]:
    return [_r(v.x), _r(v.y), _r(v.z)]


def _unsupported(target: str | None, op: str, option: str | None, reason: str) -> ReifyOpError:
    return ReifyOpError(
        "TRANSFER_UNSUPPORTED_OP", f"cannot transfer {target or op}: {reason}", target=target,
        detail={"op": op, "option": option, "reason": reason},
        hints=["cad.transfer supports pad, pocket, hole, fillet, chamfer, linear/polar patterns and mirror; see docs/cad-transfer/protocol.md"],
    )


def _name(obj: Any) -> str:
    return get_path(obj) or obj.Label


def _scalar(obj: Any, prop: str, unit: str) -> dict[str, Any]:
    from .transfer_geometry import clean_expression

    raw = getattr(obj, prop)
    out: dict[str, Any] = {"value": _r(raw.Value if hasattr(raw, "Value") else raw)}
    for name, expr in getattr(obj, "ExpressionEngine", None) or []:
        if name in (prop, f".{prop}"):
            out["expr"] = clean_expression(expr, unit)
            break
    return out


# ------------------------------------------------------------------ sketches
def _frame(sketch: Any) -> dict[str, list[float]]:
    gp = sketch.getGlobalPlacement()
    rot = gp.Rotation
    u, v, n = (rot.multVec(App.Vector(*axis)) for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    return {"origin": _vec(gp.Base), "u": _vec(u), "v": _vec(v), "n": _vec(n)}


def _support_face(sketch: Any) -> tuple[Any, str] | None:
    """(owner feature, face name) when the sketch sits on a planar face; None for origin planes."""
    entries = list(sketch.AttachmentSupport or [])
    if not entries:
        return None
    if len(entries) > 1:
        raise _unsupported(_name(sketch), "sketch", "attachment", "sketch is attached to several elements")
    owner, subs = entries[0][0], [x for x in entries[0][1] if x]
    if owner.TypeId == "App::Plane" and not subs:
        return None
    if owner.isDerivedFrom("PartDesign::Feature") and len(subs) == 1 and subs[0].startswith("Face"):
        face = owner.Shape.getElement(subs[0])
        if type(face.Surface).__name__ != "Plane":
            raise _unsupported(_name(sketch), "sketch", "non_planar_face", f"sketch is attached to a {type(face.Surface).__name__} face of {_name(owner)}; only planar faces are supported")
        return owner, subs[0]
    raise _unsupported(_name(sketch), "sketch", "attachment", f"sketch is attached to {owner.TypeId}, only origin planes and planar faces are supported")


def _placed(obj: Any) -> Any:
    """The feature's shape in world coordinates (feature shapes are body-local)."""
    shape = obj.Shape.copy()
    body = obj.getParentGeoFeatureGroup()
    if body is not None and body.TypeId == "PartDesign::Body":
        shape.Placement = body.Placement.multiply(shape.Placement)
    return shape


def _face_ref(owner: Any, name: str, who: str, op: str) -> dict[str, Any]:
    face = _placed(owner).getElement(name)
    if type(face.Surface).__name__ != "Plane":
        raise _unsupported(who, op, "non_planar_face", f"{name} is a {type(face.Surface).__name__} face; only planar faces are supported")
    centre = face.CenterOfMass
    u, v = face.Surface.parameter(centre)
    return {"origin": _vec(centre), "normal": _vec(face.normalAt(u, v)), "area": _r(face.Area)}


def _diagonal(shape: Any) -> float:
    box = _bbox(shape)
    return max(box.DiagonalLength, 1e-9)


def _edge_ref(edge: Any, who: str, op: str, strict: bool = True) -> dict[str, Any]:
    curve = type(edge.Curve).__name__
    mid = edge.valueAt((edge.FirstParameter + edge.LastParameter) / 2)
    ref: dict[str, Any] = {"midpoint": _vec(mid), "length": _r(edge.Length)}
    if curve == "Line":
        ref = {"curve": "line", **ref, "start": _vec(edge.valueAt(edge.FirstParameter)), "end": _vec(edge.valueAt(edge.LastParameter))}
    elif curve == "Circle":
        c = edge.Curve
        extra = {"centre": _vec(c.Center), "radius": _r(c.Radius), "axis": _vec(c.Axis)}
        if edge.isClosed():
            ref = {"curve": "circle", **ref, **extra}
        else:
            ref = {"curve": "arc", **ref, "start": _vec(edge.valueAt(edge.FirstParameter)), "end": _vec(edge.valueAt(edge.LastParameter)), **extra}
    elif strict:
        raise _unsupported(who, op, "edge_curve", f"edge of type {curve}: only lines, circles and arcs can be referenced")
    else:
        ref = {"curve": curve.lower(), **ref}
    return ref


def _describe(ref: dict[str, Any]) -> str:
    parts = [str(ref["curve"])]
    if "radius" in ref:
        parts.append(f"radius {ref['radius']:g}")
    parts.append(f"length {ref['length']:g}")
    parts.append("midpoint (" + ", ".join(f"{c:g}" for c in ref["midpoint"]) + ")")
    return ", ".join(parts)


def _same_edge(a: dict[str, Any], b: dict[str, Any], tol: float) -> bool:
    if a["curve"] != b["curve"] or abs(a["length"] - b["length"]) > tol:
        return False
    return all(abs(p - q) <= tol for p, q in zip(a["midpoint"], b["midpoint"]))


def _edge_refs(feature: Any, op: str) -> list[dict[str, Any]]:
    """Geometric refs of the edges a fillet or chamfer takes, resolved in the state before it."""
    name = _name(feature)
    base_obj = getattr(feature, "BaseFeature", None) or feature.Base[0]
    shape = _placed(base_obj)
    names = [f"Edge{i + 1}" for i in range(len(shape.Edges))] if feature.UseAllEdges else list(feature.Base[1])
    if not names:
        raise _unsupported(name, op, "no_edges", "the feature has no edges")
    tol = 1e-4 * _diagonal(shape)
    everything = [_edge_ref(e, name, op, strict=False) for e in shape.Edges]
    refs = []
    for edge_name in names:
        ref = _edge_ref(shape.getElement(edge_name), name, op)
        matches = [i for i, other in enumerate(everything) if _same_edge(ref, other, tol)]
        if len(matches) != 1:
            own = int(edge_name[4:]) - 1
            others = [i for i in matches if i != own] or matches
            found = [{"edge": f"Edge{i + 1}", **{k: v for k, v in everything[i].items() if k in ("curve", "midpoint", "length", "radius")}} for i in others]
            error = _unsupported(
                name, op, "ambiguous_edge",
                f"{edge_name} ({_describe(ref)}) cannot be told apart from " + "; ".join(f"{m['edge']} ({_describe(m)})" for m in found)
                + f" by curve, midpoint and length within {tol:.3g} mm; select a different edge or change the geometry so they differ",
            )
            error.detail["edge"] = edge_name
            error.detail["matches"] = found
            error.hints = ["pick other roles or a tighter selector (between two roles) for the edges, or chamfer/fillet them in separate features"]
            raise error
        refs.append(ref)
    return refs


def _dressup(feature: Any, kind: str) -> dict[str, Any]:
    name = _name(feature)
    if kind == "chamfer" and feature.ChamferType != "Equal distance":
        raise _unsupported(name, kind, "chamfer_type", f"chamfer type {feature.ChamferType}; only equal distance is supported")
    out: dict[str, Any] = {"name": name, "type": kind, "edges": _edge_refs(feature, kind)}
    out["radius" if kind == "fillet" else "size"] = _scalar(feature, "Radius" if kind == "fillet" else "Size", "mm")
    return out


def _geometry(sketch: Any) -> tuple[list[dict[str, Any]], list[list[float]]]:
    items: list[dict[str, Any]] = []
    positions: list[list[float]] = []
    for index, g in enumerate(sketch.Geometry):
        if sketch.getConstruction(index):
            continue
        kind = g.TypeId
        if kind == "Part::GeomLineSegment":
            items.append({"id": index, "type": "line", "start": [_r(g.StartPoint.x), _r(g.StartPoint.y)], "end": [_r(g.EndPoint.x), _r(g.EndPoint.y)]})
        elif kind == "Part::GeomCircle":
            items.append({"id": index, "type": "circle", "center": [_r(g.Center.x), _r(g.Center.y)], "radius": _r(g.Radius)})
            positions.append([_r(g.Center.x), _r(g.Center.y)])
        elif kind == "Part::GeomArcOfCircle":
            cx, cy = g.Center.x, g.Center.y
            start, end = g.StartPoint, g.EndPoint
            if g.Axis.z < 0:  # parameters run clockwise in the sketch: swap to counter-clockwise
                start, end = end, start
            a0 = math.degrees(math.atan2(start.y - cy, start.x - cx)) % 360.0
            a1 = math.degrees(math.atan2(end.y - cy, end.x - cx)) % 360.0
            items.append({"id": index, "type": "arc", "center": [_r(cx), _r(cy)], "radius": _r(g.Radius),
                          "start_angle": _r(a0), "end_angle": _r(a1),
                          "start": [_r(start.x), _r(start.y)], "end": [_r(end.x), _r(end.y)]})
        elif kind == "Part::GeomPoint":
            positions.append([_r(g.X), _r(g.Y)])  # points only feed hole positions; geometry stays line/arc/circle
        else:
            raise _unsupported(_name(sketch), "sketch", f"geometry:{kind.split('::')[-1]}", f"sketch geometry {kind} is not line, arc or circle")
    return items, positions


def _dimensions(sketch: Any, ids: set[int]) -> list[dict[str, Any]]:
    """Named driving dimensional constraints (level 1). Geometric constraints are not exported.

    ``refs`` are ``[geometry id, position]`` pairs as FreeCAD stores them (0 element, 1 start,
    2 end, 3 centre, origin ``[-1, 1]``). A DistanceX/DistanceY that only names one point is
    the point's coordinate, exported as the distance from the origin ``[-1, 1]``.
    """
    kinds = {"Distance": "distance", "DistanceX": "distance_x", "DistanceY": "distance_y", "Radius": "radius", "Diameter": "diameter", "Angle": "angle"}
    expressions = {}
    for entry_name, expr in getattr(sketch, "ExpressionEngine", None) or []:
        if entry_name.lstrip(".").startswith("Constraints."):
            expressions[entry_name.lstrip(".")[len("Constraints."):]] = expr
    out = []
    for c in sketch.Constraints:
        if c.Type not in kinds or not c.Name or not c.Driving:
            continue
        refs = [[c.First, c.FirstPos]]
        if c.Second != -2000:
            refs.append([c.Second, c.SecondPos])
        elif c.Type in ("DistanceX", "DistanceY") and c.FirstPos != 0:
            refs.insert(0, [-1, 1])
        if any(g >= 0 and g not in ids for g, _p in refs):
            continue  # refers to construction geometry, which is not exported
        angle = c.Type == "Angle"
        value: dict[str, Any] = {"value": _r(math.degrees(c.Value) if angle else c.Value)}
        if c.Name in expressions:
            value["expr"] = tg.clean_expression(expressions[c.Name], "deg" if angle else "mm")
        out.append({"name": c.Name, "kind": kinds[c.Type], "refs": refs, "value": value})
    return out


def _sketch_entry(sketch: Any, strict: bool) -> tuple[dict[str, Any], list[list[float]]]:
    path = _name(sketch)
    frame = _frame(sketch)
    face = _support_face(sketch)
    plane = tg.detect_plane(frame)
    if plane is None and face is None:
        raise _unsupported(path, "sketch", "tilted_plane", f"sketch normal {frame['n']} is not parallel to a world axis")
    if plane is not None:
        plane["offset"] = _r(plane["offset"])
    items, positions = _geometry(sketch)
    try:
        loops = tg.analyse_sketch(items, strict=strict)
    except tg.LoopError as error:
        raise ReifyOpError(
            "TRANSFER_INVALID_SKETCH", f"sketch {path}: {error.message}", target=path,
            detail={"reason": error.reason, "geometry": error.geometry},
            hints=["close every profile, and keep profiles apart (no crossing or touching loops)"],
        ) from error
    for loop in loops:
        loop["area"] = _r(loop["area"])
    entry = {"name": path, "frame": frame, "plane": plane, "geometry": items, "loops": loops}
    if plane is None:  # tilted sketch on a planar face: the executor sketches on that face
        entry["face_ref"] = _face_ref(face[0], face[1], path, "sketch")
    dimensions = _dimensions(sketch, {g["id"] for g in items})
    if dimensions:
        entry["dimensions"] = dimensions
    return entry, positions


# ------------------------------------------------------------------ features
def _profile(feature: Any) -> Any:
    profile = feature.Profile
    sketch, subs = (profile[0], profile[1]) if isinstance(profile, (tuple, list)) else (profile, ())
    if sketch is None or not is_sketch(sketch):
        raise _unsupported(_name(feature), _OP_NAMES.get(feature.TypeId, feature.TypeId), "profile", "the profile is not a sketch")
    if any(subs):
        raise _unsupported(_name(feature), _OP_NAMES.get(feature.TypeId, feature.TypeId), "profile_subset", "the profile selects parts of the sketch")
    return sketch


def _opposed(n: list[float], flip: bool) -> list[float]:
    return [_r(-c if flip else c) for c in n]


def _pad_or_pocket(feature: Any, kind: str, sketch_entry: dict[str, Any]) -> dict[str, Any]:
    name = _name(feature)
    props = feature.PropertiesList
    side = getattr(feature, "SideType", "One side") if "SideType" in props else "One side"
    if side == "Two sides" or feature.Type == "TwoLengths":
        raise _unsupported(name, kind, "two_lengths", "two-sided extent")
    up_to_face = kind == "pad" and feature.Type == "UpToFace"
    if up_to_face:
        if feature.Reversed:
            raise _unsupported(name, kind, "reversed_up_to_face", "reversed pad up to a face")
        if abs(feature.Offset.Value) > 1e-9:
            raise _unsupported(name, kind, "offset", "up-to-face offset")
        target = feature.UpToFace
        if target is None or target[0] is None or not target[1]:
            raise _unsupported(name, kind, "up_to_face", "the end face is not set")
    elif feature.Type not in (("Length",) if kind == "pad" else ("Length", "ThroughAll")):
        option = {"UpToLast": "up_to_last", "UpToFirst": "up_to_first", "UpToFace": "up_to_face", "UpToShape": "up_to_shape"}.get(feature.Type, feature.Type)
        raise _unsupported(name, kind, option, f"extent type {feature.Type}")
    if "UseCustomVector" in props and feature.UseCustomVector:
        raise _unsupported(name, kind, "custom_direction", "extrusion along a custom vector")
    taper = feature.TaperAngle.Value if "TaperAngle" in props else 0.0
    if abs(taper) > 1e-9:
        raise _unsupported(name, kind, "taper", "tapered extrusion")
    midplane = bool(feature.Midplane) or side == "Symmetric"
    if kind == "pocket" and midplane:
        raise _unsupported(name, kind, "midplane", "symmetric pocket")
    reversed_ = bool(feature.Reversed)
    n = sketch_entry["frame"]["n"]
    out: dict[str, Any] = {"name": name, "type": kind, "sketch": sketch_entry["name"]}
    if kind == "pad":
        out["direction"] = _opposed(n, reversed_)
        if up_to_face:
            out["extent"] = {"type": "up_to_face", "face_ref": _face_ref(target[0], target[1][0], name, kind)}
        else:
            out["extent"] = {"type": "length", "length": _scalar(feature, "Length", "mm")}
        out["midplane"] = midplane
    else:
        out["direction"] = _opposed(n, not reversed_)
        out["extent"] = {"type": "through_all"} if feature.Type == "ThroughAll" else {"type": "length", "length": _scalar(feature, "Length", "mm")}
    out["reversed"] = reversed_
    return out


def _hole(feature: Any, sketch_entry: dict[str, Any], positions: list[list[float]]) -> dict[str, Any]:
    name = _name(feature)
    if feature.Tapered:
        raise _unsupported(name, "hole", "tapered", "tapered hole")
    if feature.Midplane:
        raise _unsupported(name, "hole", "midplane", "symmetric hole")
    extra: dict[str, Any] = {}
    if feature.Threaded:
        if feature.ModelThread:
            raise _unsupported(name, "hole", "modeled_thread", "modeled threads are not supported; only cosmetic threads")
        if not str(feature.ThreadType).startswith("ISOMetric"):
            raise _unsupported(name, "hole", "thread_type", f"thread type {feature.ThreadType}")
        size, _sep, pitch = str(feature.ThreadSize).partition("x")
        extra["thread"] = {"standard": "ISO", "size": size, "pitch_mm": _r(float(pitch)) if pitch else None, "modeled": False}
    cut = str(feature.HoleCutType)
    if cut == "Counterbore":
        extra["counterbore"] = {"diameter": _scalar(feature, "HoleCutDiameter", "mm"), "depth": _scalar(feature, "HoleCutDepth", "mm")}
    elif cut == "Countersink":
        extra["countersink"] = {"diameter": _scalar(feature, "HoleCutDiameter", "mm"), "angle_deg": _r(feature.HoleCutCountersinkAngle.Value)}
    elif cut not in ("None", ""):
        raise _unsupported(name, "hole", cut.lower(), f"{cut} hole")
    depth_type = str(feature.DepthType)
    if depth_type == "ThroughAll":
        extent: dict[str, Any] = {"type": "through_all"}
    elif depth_type == "Dimension":
        extent = {"type": "blind", "depth": _scalar(feature, "Depth", "mm")}
        if feature.DrillPoint == "Flat":
            extra["drill_point"] = {"type": "flat", "angle_deg": 180.0}
        elif feature.DrillPoint == "Angled":
            if feature.DrillForDepth:
                raise _unsupported(name, "hole", "drill_for_depth", "depth measured to the drill point")
            extra["drill_point"] = {"type": "angled", "angle_deg": _r(feature.DrillPointAngle.Value)}
        else:
            raise _unsupported(name, "hole", str(feature.DrillPoint).lower(), f"drill point {feature.DrillPoint}")
    else:
        raise _unsupported(name, "hole", depth_type.lower(), f"depth type {depth_type}")
    n = sketch_entry["frame"]["n"]
    return {
        "name": name, "type": "hole", "sketch": sketch_entry["name"],
        "direction": _opposed(n, not bool(feature.Reversed)),
        "extent": extent, "diameter": _scalar(feature, "Diameter", "mm"),
        **extra, "positions": positions, "reversed": bool(feature.Reversed),
    }


_LOCAL_AXES = {"X_Axis": (1.0, 0.0, 0.0), "Y_Axis": (0.0, 1.0, 0.0), "Z_Axis": (0.0, 0.0, 1.0)}


def _origin_axis(link: Any, body: Any) -> Any | None:
    """World direction of an origin axis of the body (Body placement applied), else None."""
    owner, subs = (link[0], link[1]) if isinstance(link, (tuple, list)) else (link, ())
    local = _LOCAL_AXES.get(getattr(owner, "Role", "")) if owner is not None and owner.TypeId == "App::Line" else None
    if local is None or any(subs):
        return None
    return body.Placement.Rotation.multVec(App.Vector(*local))


def _originals(feature: Any, exported: set[str]) -> list[str]:
    out = []
    for original in feature.Originals:
        path = _name(original)
        if path not in exported:
            raise _unsupported(_name(feature), _OP_NAMES[feature.TypeId], "original", f"original {path} is not an exported feature")
        out.append(path)
    return out


def _linear(feature: Any, body: Any, exported: set[str]) -> dict[str, Any]:
    name = _name(feature)
    if feature.Mode != "Extent":
        raise _unsupported(name, "linear_pattern", "spacing_mode", f"pattern mode {feature.Mode}")
    direction = _origin_axis(feature.Direction, body)
    if direction is None:
        raise _unsupported(name, "linear_pattern", "direction", "the pattern direction must be an X, Y or Z origin axis of the body")
    if feature.Reversed:
        direction = direction * -1
    length = _scalar(feature, "Length", "mm")
    count = int(feature.Occurrences)
    spacing = length["value"] / (count - 1) if count > 1 else 0.0
    return {
        "name": name, "type": "linear_pattern", "originals": _originals(feature, exported),
        "direction": _vec(direction), "length": length, "occurrences": count,
        "spacing": {"value": _r(spacing)}, "reversed": bool(feature.Reversed),
    }


def _mirror(feature: Any, exported: set[str]) -> dict[str, Any]:
    name = _name(feature)
    link = feature.MirrorPlane
    owner, subs = (link[0], link[1]) if isinstance(link, (tuple, list)) else (link, ())
    if owner is None or owner.TypeId != "App::Plane" or any(subs):
        raise _unsupported(name, "mirror", "plane", "the mirror plane must be an origin plane of the body")
    placement = owner.getGlobalPlacement()
    return {
        "name": name, "type": "mirror", "originals": _originals(feature, exported),
        "plane": {"origin": _vec(placement.Base), "normal": _vec(placement.Rotation.multVec(App.Vector(0, 0, 1)))},
    }


def _polar(feature: Any, body: Any, exported: set[str]) -> dict[str, Any]:
    name = _name(feature)
    if feature.Mode != "Extent":
        raise _unsupported(name, "polar_pattern", "offset_mode", f"pattern mode {feature.Mode}")
    direction = _origin_axis(feature.Axis, body)
    if direction is None:
        raise _unsupported(name, "polar_pattern", "axis", "the pattern axis must be an X, Y or Z origin axis of the body")
    if feature.Reversed:
        direction = direction * -1
    angle = _scalar(feature, "Angle", "deg")
    return {
        "name": name, "type": "polar_pattern", "originals": _originals(feature, exported),
        "axis": {"origin": _vec(body.Placement.Base), "direction": _vec(direction)},
        "angle": angle, "occurrences": int(feature.Occurrences), "full_circle": abs(angle["value"] - 360.0) < 1e-9,
    }


def _body_entry(body: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if getattr(body, "BaseFeature", None) is not None:
        raise _unsupported(_name(body), "body", "base_feature", "the body is based on another solid")
    features_objs = [obj for obj in body.Group if is_feature(obj)]
    if features_objs and body.Tip is not features_objs[-1]:
        raise _unsupported(_name(body), "body", "tip", "features after the body Tip are not part of the result")
    features: list[dict[str, Any]] = []
    sketches: dict[str, dict[str, Any]] = {}
    positions_of: dict[str, list[list[float]]] = {}
    volumes: list[dict[str, Any]] = []
    exported: set[str] = set()
    for obj in features_objs:
        name = _name(obj)
        op = _OP_NAMES.get(obj.TypeId)
        if op not in ("pad", "pocket", "hole", "polar_pattern", "linear_pattern", "mirror", "fillet", "chamfer"):
            raise _unsupported(name, op or obj.TypeId, None, f"{op or obj.TypeId} is not supported by cad.transfer" if op else f"unknown feature type {obj.TypeId}")
        if obj.Suppressed if "Suppressed" in obj.PropertiesList else False:
            raise _unsupported(name, op, "suppressed", "suppressed feature")
        if obj.Shape.isNull() or "Invalid" in obj.State:
            raise ReifyOpError("FEATURE_FAILED", f"{name} did not recompute", target=name)
        if op == "polar_pattern":
            features.append(_polar(obj, body, exported))
        elif op == "linear_pattern":
            features.append(_linear(obj, body, exported))
        elif op == "mirror":
            features.append(_mirror(obj, exported))
        elif op in ("fillet", "chamfer"):
            features.append(_dressup(obj, op))
        else:
            sketch = _profile(obj)
            key = _name(sketch)
            if key not in sketches:
                sketches[key], positions_of[key] = _sketch_entry(sketch, strict=op != "hole")
                sketches[key]["_sketch"] = sketch
            features.append(_hole(obj, sketches[key], positions_of[key]) if op == "hole" else _pad_or_pocket(obj, op, sketches[key]))
        exported.add(name)
        volumes.append({"name": name, "volume_mm3": _r(obj.Shape.Volume)})
    order = {obj.Name: i for i, obj in enumerate(body.Group)}
    ordered = sorted(sketches.values(), key=lambda s: order[s["_sketch"].Name])
    for entry in ordered:
        del entry["_sketch"]
    return {"name": _name(body), "sketches": ordered, "features": features}, volumes


def _bbox(shape: Any) -> Any:
    try:
        return shape.optimalBoundingBox(True, False)
    except Exception:
        return shape.BoundBox


def _reject_unsupported_objects(doc: Any) -> None:
    for obj in doc.Objects:
        path = get_path(obj)
        if obj.TypeId in ("App::Part", "App::Link") or "OccurrenceKind" in obj.PropertiesList:
            raise _unsupported(path or obj.Label, "assembly", "occurrence", "assemblies and occurrences are exported with export_assembly")
        if path and obj.TypeId == "Part::Feature":
            raise _unsupported(path, "import", "imported_solid", "imported solids are not supported by cad.transfer")


def _parameters(session: Any) -> list[dict[str, Any]]:
    """The Reify ``Params``: value, unit (``mm``, ``deg`` or empty) and expression if bound."""
    vs = session.params_object()
    if vs is None:
        return []
    expressions = {name: expr for name, expr in getattr(vs, "ExpressionEngine", None) or []}
    out = []
    for name in sorted(session.param_names()):
        kind = vs.getTypeIdOfProperty(name)
        unit = "mm" if kind == "App::PropertyLength" else "deg" if kind == "App::PropertyAngle" else ""
        raw = getattr(vs, name)
        entry: dict[str, Any] = {"name": name, "value": _r(raw.Value if hasattr(raw, "Value") else raw), "unit": unit}
        if name in expressions:
            entry["expr"] = tg.clean_expression(expressions[name], unit or None)
        out.append(entry)
    return out


def _material(session: Any) -> dict[str, Any] | None:
    """Density only when the part declares it: the Params entry ``density`` in g/cm3 (queries.mass)."""
    vs = session.params_object()
    if vs is None or "density" not in session.param_names():
        return None
    return {"density_kg_m3": _r(float(getattr(vs, "density")) * 1000.0)}


def _source_doc(session: Any) -> str:
    root = Path(session.root)
    try:
        return Path(session.fcstd).relative_to(root).as_posix()
    except ValueError:
        return Path(session.fcstd).as_posix()


def canonicalize(session: Any, body_path: str | None = None) -> dict[str, Any]:
    """Canonical feature JSON (``reify.features/1``) for the bodies of the session's document.

    ``body_path`` restricts the output to one body (a part linked into an assembly).
    """
    from .session import _sha256

    doc = session.doc
    _reject_unsupported_objects(doc)
    body_objs = [b for b in bodies(doc) if body_path is None or get_path(b) == body_path]
    if not body_objs:
        raise _unsupported(body_path, "document", "no_body", "the document has no body")
    entries, all_volumes = [], []
    volume = 0.0
    box = None
    for body in body_objs:
        entry, volumes = _body_entry(body)
        entries.append(entry)
        all_volumes += volumes
        if not body.Shape.isNull():
            volume += body.Shape.Volume
            bb = _bbox(body.Shape)
            if box is None:
                box = App.BoundBox(bb)
            else:
                box.add(bb)
    part = _name(body_objs[0]) if len(body_objs) == 1 else Path(session.fcstd).stem
    data: dict[str, Any] = {
        "schema": SCHEMA, "units": "mm", "part": part,
        "source": {"doc": _source_doc(session), "sha256": _sha256(Path(session.fcstd))},
    }
    parameters = _parameters(session)
    if parameters:
        data["parameters"] = parameters
    material = _material(session)
    if material:
        data["material"] = material
    data["bodies"] = entries
    data["reference"] = {
        "volume_mm3": _r(volume),
        "bbox": {"min": [_r(box.XMin), _r(box.YMin), _r(box.ZMin)], "max": [_r(box.XMax), _r(box.YMax), _r(box.ZMax)]} if box else None,
        "feature_volumes": all_volumes,
    }
    return data


def _write_json(data: dict[str, Any], output: str) -> str:
    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return str(target)


def export_features(session: Any, output: str | None = None, reference_step: str | None = None) -> dict[str, Any]:
    """Worker result: the canonical JSON plus bookkeeping; optionally write the JSON and a reference STEP."""
    data = canonicalize(session)
    result: dict[str, Any] = {
        "features": data, "featureCount": sum(len(b["features"]) for b in data["bodies"]), "part": data["part"],
    }
    if output:
        result["path"] = _write_json(data, output)
    if reference_step:
        from . import export as export_module

        export_module.write_step(session, Path(reference_step))
        result["referenceStep"] = str(reference_step)
    return result


# ------------------------------------------------------------------ assemblies
def _own_step_source(session: Any, unit: Any) -> tuple[str, Any, str]:
    """(part document path, its session, body path) for an ``import_step`` unit that Reify wrote itself.

    The STEP carries a ``<step>.source.json`` sidecar (``reify.step-source/1``, see
    ``export.write_source``). No sidecar means a bought-in STEP; a sidecar whose part document has
    changed since means the STEP is stale.
    """
    from .assembly import file_sha256
    from .export import SOURCE_SCHEMA, source_sidecar

    step = session.resolve_project_path(unit.source_path)
    sidecar = source_sidecar(step)
    unknown = lambda why: _unsupported(  # noqa: E731
        unit.path, "import_step", "unknown_step_source",
        f"{unit.path} imports {unit.source_path}, which is not a STEP written by Reify from a project part ({why}); only Reify parts can be transferred")
    if not sidecar.exists():
        raise unknown("no .source.json next to it")
    try:
        source = json.loads(sidecar.read_text(encoding="utf-8"))
        assert source["schema"] == SOURCE_SCHEMA
        fcstd, fcstd_sha, step_sha, body_path = source["fcstd"], source["fcstdSha256"], source["stepSha256"], source.get("body")
    except (ValueError, KeyError, AssertionError, OSError):
        raise unknown("unreadable .source.json") from None
    if file_sha256(step) != step_sha:
        raise unknown("the STEP changed after Reify wrote it")
    if not body_path:
        raise _unsupported(unit.path, "import_step", "unknown_step_source", f"{unit.source_path} was written from {fcstd} as more than one body; import one part's STEP")
    absolute = session.resolve_project_path(fcstd)
    if not absolute.exists():
        raise unknown(f"its part document {fcstd} no longer exists")
    if file_sha256(absolute) != fcstd_sha:
        error = _unsupported(
            unit.path, "import_step", "stale_step",
            f"{unit.path} imports {unit.source_path}, written from {fcstd} revision {source.get('rev')}; the part has changed since")
        error.hints = [f"rebuild the part ({fcstd}) so Reify rewrites its STEP, then import_step again (or link the part)"]
        raise error
    owner = session.registry.source(absolute)
    if not any(get_path(b) == body_path for b in bodies(owner.doc)):
        raise unknown(f"{fcstd} has no body {body_path}")
    return fcstd, owner, body_path


def canonicalize_assembly(session: Any) -> dict[str, Any]:
    """``reify.assembly/1``: the linked parts with their features, and each occurrence's world transform.

    Joints are already applied (the occurrence Placement is the solved pose). An ``import_step``
    of a STEP that Reify wrote from a project part is an occurrence of that part; bought-in or
    stale STEPs and bodies of the assembly document itself are refused.
    """
    from .assembly import OCCURRENCE, REFERENCE, units

    doc = session.doc
    session.sync_links()
    found = [u for u in units(session) if not (u.kind == "body" and not any(is_feature(o) for o in u.obj.Group))]  # the scaffold body is empty
    if not found:
        raise _unsupported(None, "assembly", "no_occurrence", "the document has no occurrences")
    #: (unit, part document path as written in the project, owner session, body path)
    resolved = []
    for unit in found:
        if unit.kind == REFERENCE:
            resolved.append((unit, *_own_step_source(session, unit)))
        elif unit.kind == OCCURRENCE:
            if unit.body is None or unit.owner is None:
                raise _unsupported(unit.path, "link", "missing_part", f"the part {unit.source_path} or its body is missing")
            resolved.append((unit, unit.source_path, unit.owner, get_path(unit.body)))
        else:
            raise _unsupported(unit.path, "assembly", "inline_body", f"{unit.path} is a body of the assembly document; link it as a part")
    per_doc: dict[str, set[str]] = {}
    for _unit, ref, _owner, body_path in resolved:
        per_doc.setdefault(ref, set()).add(body_path)
    parts: dict[tuple[str, str], dict[str, Any]] = {}
    occurrences, volumes = [], []
    volume = 0.0
    box = None
    for unit, ref_path, owner, body_path in resolved:
        key = (ref_path, body_path)
        if key not in parts:
            ref = ref_path if len(per_doc[ref_path]) == 1 else f"{ref_path}#{body_path}"
            parts[key] = {"ref": ref, "name": body_path, "features": canonicalize(owner, body_path)}
        placement = unit.placement
        if unit.kind == OCCURRENCE:
            # A linked occurrence holds the body shape without the part's Body placement (occurrence_shape),
            # while parts[].features are in the part's world frame, which includes that placement.
            # world = pose * local = pose * B^-1 * features.
            placement = placement.multiply(unit.body.Placement.inverse())
        rows = placement.Rotation.toMatrix()
        occurrences.append({
            "name": unit.path, "part": parts[key]["ref"],
            "transform": {
                "origin": _vec(placement.Base),
                "rotation": [[_r(rows.A11), _r(rows.A12), _r(rows.A13)], [_r(rows.A21), _r(rows.A22), _r(rows.A23)], [_r(rows.A31), _r(rows.A32), _r(rows.A33)]],
            },
        })
        shape = unit.shape()
        volumes.append({"name": unit.path, "volume_mm3": _r(shape.Volume)})
        volume += shape.Volume
        bb = _bbox(shape)
        if box is None:
            box = App.BoundBox(bb)
        else:
            box.add(bb)
    del doc
    return {
        "schema": "reify.assembly/1", "units": "mm", "name": Path(session.fcstd).stem,
        "source": {"doc": _source_doc(session)},
        "parts": list(parts.values()), "occurrences": occurrences,
        "reference": {
            "volume_mm3": _r(volume),
            "bbox": {"min": [_r(box.XMin), _r(box.YMin), _r(box.ZMin)], "max": [_r(box.XMax), _r(box.YMax), _r(box.ZMax)]},
            "feature_volumes": volumes,
        },
    }


def export_assembly(session: Any, output: str | None = None, reference_step: str | None = None) -> dict[str, Any]:
    data = canonicalize_assembly(session)
    result: dict[str, Any] = {"assembly": data, "partCount": len(data["parts"]), "occurrenceCount": len(data["occurrences"]), "part": data["name"]}
    if output:
        result["path"] = _write_json(data, output)
    if reference_step:
        from . import export as export_module

        export_module.write_step(session, Path(reference_step))
        result["referenceStep"] = str(reference_step)
    return result
