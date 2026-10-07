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
#: Sketches attached to a face of another feature are refused (issue requirement).
ALLOW_FACE_SKETCHES = False

_OP_NAMES = {
    "PartDesign::Pad": "pad", "PartDesign::Pocket": "pocket", "PartDesign::Hole": "hole",
    "PartDesign::PolarPattern": "polar_pattern", "PartDesign::LinearPattern": "linear_pattern",
    "PartDesign::Mirrored": "mirror", "PartDesign::MultiTransform": "multi_transform",
    "PartDesign::Fillet": "fillet", "PartDesign::Chamfer": "chamfer", "PartDesign::Revolution": "revolution",
    "PartDesign::Groove": "groove", "PartDesign::Loft": "loft", "PartDesign::Pipe": "sweep",
    "PartDesign::Draft": "draft", "PartDesign::Thickness": "thickness",
}
_AXIS_LOCAL = {"X_Axis": (1.0, 0.0, 0.0), "Y_Axis": (0.0, 1.0, 0.0), "Z_Axis": (0.0, 0.0, 1.0)}


def _r(x: float) -> float:
    return round(float(x), 9) + 0.0


def _vec(v: Any) -> list[float]:
    return [_r(v.x), _r(v.y), _r(v.z)]


def _unsupported(target: str | None, op: str, option: str | None, reason: str) -> ReifyOpError:
    return ReifyOpError(
        "TRANSFER_UNSUPPORTED_OP", f"cannot transfer {target or op}: {reason}", target=target,
        detail={"op": op, "option": option, "reason": reason},
        hints=["P0/P1 transfer supports pad, pocket, hole (through all, plain) and polar_pattern on origin-plane sketches"],
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


def _check_support(sketch: Any, feature: Any) -> None:
    for entry in sketch.AttachmentSupport or []:
        owner, subs = entry[0], entry[1]
        if owner.TypeId == "App::Plane":
            continue
        if not ALLOW_FACE_SKETCHES and (any(subs) or owner.isDerivedFrom("PartDesign::Feature")):
            raise _unsupported(_name(sketch), "sketch", "attached_to_face",
                               f"sketch {_name(sketch)} is attached to a face of {_name(owner)}; use an origin plane with an offset")
        raise _unsupported(_name(sketch), "sketch", "attachment", f"sketch is attached to {owner.TypeId}, only origin planes are supported")


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


def _sketch_entry(sketch: Any, strict: bool) -> tuple[dict[str, Any], list[list[float]]]:
    path = _name(sketch)
    frame = _frame(sketch)
    plane = tg.detect_plane(frame)
    if plane is None:
        raise _unsupported(path, "sketch", "tilted_plane", f"sketch normal {frame['n']} is not parallel to a world axis")
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
    return {"name": path, "frame": frame, "plane": plane, "geometry": items, "loops": loops}, positions


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
    if feature.Type not in (("Length",) if kind == "pad" else ("Length", "ThroughAll")):
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
        out["extent"] = {"type": "length", "length": _scalar(feature, "Length", "mm")}
        out["midplane"] = midplane
    else:
        out["direction"] = _opposed(n, not reversed_)
        out["extent"] = {"type": "through_all"} if feature.Type == "ThroughAll" else {"type": "length", "length": _scalar(feature, "Length", "mm")}
    out["reversed"] = reversed_
    return out


def _hole(feature: Any, sketch_entry: dict[str, Any], positions: list[list[float]]) -> dict[str, Any]:
    name = _name(feature)
    if feature.Threaded:
        raise _unsupported(name, "hole", "thread", "threaded hole")
    cut = str(feature.HoleCutType)
    if cut not in ("None", "", "none"):
        option = "counterbore" if "bore" in cut.lower() else "countersink" if "sink" in cut.lower() else cut.lower()
        raise _unsupported(name, "hole", option, f"{cut} hole")
    if feature.DepthType != "ThroughAll":
        option = "blind" if feature.DepthType == "Dimension" else str(feature.DepthType).lower()
        raise _unsupported(name, "hole", option, f"depth type {feature.DepthType}; only through-all holes are supported")
    if feature.Tapered:
        raise _unsupported(name, "hole", "tapered", "tapered hole")
    if feature.Midplane:
        raise _unsupported(name, "hole", "midplane", "symmetric hole")
    n = sketch_entry["frame"]["n"]
    return {
        "name": name, "type": "hole", "sketch": sketch_entry["name"],
        "direction": _opposed(n, not bool(feature.Reversed)),
        "extent": {"type": "through_all"}, "diameter": _scalar(feature, "Diameter", "mm"),
        "positions": positions, "reversed": bool(feature.Reversed),
    }


def _polar(feature: Any, body: Any, exported: set[str]) -> dict[str, Any]:
    name = _name(feature)
    if feature.Mode != "Extent":
        raise _unsupported(name, "polar_pattern", "offset_mode", f"pattern mode {feature.Mode}")
    axis = feature.Axis
    owner, subs = (axis[0], axis[1]) if isinstance(axis, (tuple, list)) else (axis, ())
    local = _AXIS_LOCAL.get(getattr(owner, "Role", "")) if owner is not None and owner.TypeId == "App::Line" else None
    if local is None or any(subs):
        raise _unsupported(name, "polar_pattern", "axis", "the pattern axis must be an X, Y or Z origin axis of the body")
    placement = body.Placement
    direction = placement.Rotation.multVec(App.Vector(*local))
    if feature.Reversed:
        direction = direction * -1
    originals = []
    for original in feature.Originals:
        path = _name(original)
        if path not in exported:
            raise _unsupported(name, "polar_pattern", "original", f"original {path} is not an exported feature")
        originals.append(path)
    angle = _scalar(feature, "Angle", "deg")
    return {
        "name": name, "type": "polar_pattern", "originals": originals,
        "axis": {"origin": _vec(placement.Base), "direction": _vec(direction)},
        "angle": angle, "occurrences": int(feature.Occurrences), "full_circle": abs(angle["value"] - 360.0) < 1e-9,
    }


def _body_entry(body: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if getattr(body, "BaseFeature", None) is not None:
        raise _unsupported(_name(body), "body", "base_feature", "the body is based on another solid")
    features_objs = [obj for obj in body.Group if is_feature(obj)]
    if features_objs and body.Tip is not features_objs[-1]:
        raise _unsupported(_name(body), "body", "tip", "features after the body Tip are not part of the result")
    used: dict[str, tuple[Any, bool, bool]] = {}  # sketch path -> (sketch, strict, with_points)
    features: list[dict[str, Any]] = []
    sketches: dict[str, dict[str, Any]] = {}
    positions_of: dict[str, list[list[float]]] = {}
    volumes: list[dict[str, Any]] = []
    exported: set[str] = set()
    for obj in features_objs:
        name = _name(obj)
        op = _OP_NAMES.get(obj.TypeId)
        if op not in ("pad", "pocket", "hole", "polar_pattern"):
            raise _unsupported(name, op or obj.TypeId, None, f"{op or obj.TypeId} is not supported by cad.transfer" if op else f"unknown feature type {obj.TypeId}")
        if obj.Suppressed if "Suppressed" in obj.PropertiesList else False:
            raise _unsupported(name, op, "suppressed", "suppressed feature")
        if obj.Shape.isNull() or "Invalid" in obj.State:
            raise ReifyOpError("FEATURE_FAILED", f"{name} did not recompute", target=name)
        if op == "polar_pattern":
            features.append(_polar(obj, body, exported))
        else:
            sketch = _profile(obj)
            _check_support(sketch, obj)
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
            raise _unsupported(path or obj.Label, "assembly", "occurrence", "assemblies and occurrences are not supported by cad.transfer")
        if path and obj.TypeId == "Part::Feature":
            raise _unsupported(path, "import", "imported_solid", "imported solids are not supported by cad.transfer")


def canonicalize(session: Any) -> dict[str, Any]:
    """Canonical feature JSON (``reify.features/1``) for every body of the session's document."""
    from .session import _sha256

    doc = session.doc
    _reject_unsupported_objects(doc)
    body_objs = bodies(doc)
    if not body_objs:
        raise _unsupported(None, "document", "no_body", "the document has no body")
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
    root = Path(session.root)
    try:
        source_doc = Path(session.fcstd).relative_to(root).as_posix()
    except ValueError:
        source_doc = Path(session.fcstd).as_posix()
    part = _name(body_objs[0]) if len(body_objs) == 1 else Path(session.fcstd).stem
    return {
        "schema": SCHEMA, "units": "mm", "part": part,
        "source": {"doc": source_doc, "sha256": _sha256(Path(session.fcstd))},
        "bodies": entries,
        "reference": {
            "volume_mm3": _r(volume),
            "bbox": {"min": [_r(box.XMin), _r(box.YMin), _r(box.ZMin)], "max": [_r(box.XMax), _r(box.YMax), _r(box.ZMax)]} if box else None,
            "feature_volumes": all_volumes,
        },
    }


def export_features(session: Any, output: str | None = None, reference_step: str | None = None) -> dict[str, Any]:
    """Worker result: the canonical JSON plus bookkeeping; optionally write the JSON and a reference STEP."""
    data = canonicalize(session)
    result: dict[str, Any] = {
        "features": data, "featureCount": sum(len(b["features"]) for b in data["bodies"]), "part": data["part"],
    }
    if output:
        target = Path(output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        result["path"] = str(target)
    if reference_step:
        from . import export as export_module

        export_module.write_step(session, Path(reference_step))
        result["referenceStep"] = str(reference_step)
    return result
