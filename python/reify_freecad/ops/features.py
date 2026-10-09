"""Part Design feature ops (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

from ..core import is_sketch, origin_feature
from ..errors import ReifyOpError
from ..roles import resolve_edges, resolve_single_face
from .sketch import build_sketch


def _sketch_of(ctx: Any, op: dict[str, Any]) -> Any:
    sketch = ctx.lookup(op["sketch"], field="sketch")
    if not is_sketch(sketch):
        raise ReifyOpError("OP_SCHEMA_INVALID", f"'{op['sketch']}' is not a sketch", detail={"path": "sketch", "reason": "not a sketch"})
    return sketch


def sketch(ctx: Any, op: dict[str, Any]) -> None:
    body = ctx.body_for(op)
    if "on" in op:
        ctx.recompute()  # roles are read from the current shape
    created = build_sketch(ctx, body, op)
    ctx.register(created, op["name"])


def _new_feature(ctx: Any, op: dict[str, Any], type_id: str, hint: Any | None = None) -> tuple[Any, Any]:
    body = ctx.body_for(op, hint=hint)
    obj = body.newObject(type_id, type_id.split("::")[1])
    return body, obj


def pad(ctx: Any, op: dict[str, Any]) -> None:
    sk = _sketch_of(ctx, op)
    kind = op.get("type", "length")
    # Resolve the end face first: creating the pad moves the body's Tip to it.
    up_to = resolve_single_face(ctx, op["face"]) if kind == "up_to_face" else None
    _body, obj = _new_feature(ctx, op, "PartDesign::Pad", sk)
    obj.Profile = sk
    obj.Type = {"length": "Length", "through_all": "UpToLast", "up_to_face": "UpToFace"}[kind]
    if up_to is not None:
        owner, face = up_to
        obj.UpToFace = (owner, [face])
    ctx.set_value(obj, "Length", op["length"])
    obj.Reversed = bool(op.get("reversed", False))
    obj.Midplane = bool(op.get("midplane", False))
    ctx.register(obj, op["name"])


def pocket(ctx: Any, op: dict[str, Any]) -> None:
    sk = _sketch_of(ctx, op)
    _body, obj = _new_feature(ctx, op, "PartDesign::Pocket", sk)
    obj.Profile = sk
    obj.Type = {"length": "Length", "through_all": "ThroughAll"}[op.get("type", "length")]
    ctx.set_value(obj, "Length", op["depth"])
    obj.Reversed = bool(op.get("reversed", False))
    ctx.register(obj, op["name"])


def hole(ctx: Any, op: dict[str, Any]) -> None:
    sk = _sketch_of(ctx, op)
    _body, obj = _new_feature(ctx, op, "PartDesign::Hole", sk)
    obj.Profile = sk
    ctx.set_value(obj, "Diameter", op["diameter"])
    through = op.get("type", "blind") == "through_all"
    obj.DepthType = "ThroughAll" if through else "Dimension"
    if not through:
        ctx.set_value(obj, "Depth", op["depth"])
    if "thread" in op:
        _thread(obj, op)
    if "counterbore" in op:
        spec = _dict(op["counterbore"], ("diameter", "depth"), "counterbore")
        obj.HoleCutType = "Counterbore"
        ctx.set_value(obj, "HoleCutDiameter", spec["diameter"])
        ctx.set_value(obj, "HoleCutDepth", spec["depth"])
    elif "countersink" in op:
        spec = _dict(op["countersink"], ("diameter",), "countersink", optional=("angle",))
        obj.HoleCutType = "Countersink"
        ctx.set_value(obj, "HoleCutDiameter", spec["diameter"])
        ctx.set_value(obj, "HoleCutCountersinkAngle", spec.get("angle", 90))
    ctx.register(obj, op["name"])


def _thread(obj: Any, op: dict[str, Any]) -> None:
    """ISO metric coarse thread: ``"M6"`` (or ``"M6x1"``) as FreeCAD spells it, ``M6x1``."""
    wanted = op["thread"]
    obj.Threaded = True
    obj.ModelThread = False
    obj.ThreadType = "ISOMetricProfile"
    sizes = list(obj.getEnumerationsOfProperty("ThreadSize"))
    matches = [wanted] if wanted in sizes else [size for size in sizes if size.startswith(f"{wanted}x")]
    if not matches:
        raise ReifyOpError(
            "HOLE_FAILED", f"unsupported thread {wanted!r}", target=op["name"],
            detail={"thread": wanted, "allowed": sizes[:30]}, hints=["use an ISO metric size such as M6"],
        )
    obj.ThreadSize = matches[0]


def _dict(value: Any, required: tuple[str, ...], name: str, optional: tuple[str, ...] = ()) -> dict[str, Any]:
    if not isinstance(value, dict) or any(key not in value for key in required) or set(value) - set(required) - set(optional):
        raise ReifyOpError("OP_SCHEMA_INVALID", f"{name} must be an object with {list(required)}", detail={"path": name, "reason": "bad shape"})
    return value


def _dressup(ctx: Any, op: dict[str, Any], type_id: str, value_prop: str, value_key: str) -> None:
    ctx.recompute()
    body, names = resolve_edges(ctx, op["edges"])
    base = body.Tip
    obj = body.newObject(type_id, type_id.split("::")[1])
    obj.Base = (base, names)
    ctx.set_value(obj, value_prop, op[value_key])
    ctx.register(obj, op["name"])


def fillet(ctx: Any, op: dict[str, Any]) -> None:
    _dressup(ctx, op, "PartDesign::Fillet", "Radius", "radius")


def chamfer(ctx: Any, op: dict[str, Any]) -> None:
    _dressup(ctx, op, "PartDesign::Chamfer", "Size", "size")


def _originals(ctx: Any, op: dict[str, Any]) -> tuple[Any, list[Any]]:
    objs = [ctx.lookup(path, field="features") for path in op["features"]]
    body = ctx.body_for(op, hint=objs[0])
    return body, objs


def _axis_reference(body: Any, token: str) -> tuple[Any, bool]:
    reversed_ = token.startswith("-")
    return origin_feature(body, f"{token.lstrip('-')}_Axis"), reversed_


def _new_transformed(ctx: Any, body: Any, type_id: str, originals: list[Any]) -> Any:
    """Patterns join the body only after their Originals are set: a Transformed
    feature without originals is not a solid feature, so the body would not
    move its Tip to it."""
    obj = ctx.doc.addObject(type_id, type_id.split("::")[1])
    obj.Originals = originals
    body.addObject(obj)
    return obj


def linear_pattern(ctx: Any, op: dict[str, Any]) -> None:
    body, objs = _originals(ctx, op)
    obj = _new_transformed(ctx, body, "PartDesign::LinearPattern", objs)
    axis, reverse = _axis_reference(body, op["direction"])
    obj.Direction = (axis, [""])
    obj.Reversed = reverse
    obj.Mode = "Extent"
    ctx.set_value(obj, "Length", op["length"])
    obj.Occurrences = int(op["count"])
    ctx.register(obj, op["name"])


def polar_pattern(ctx: Any, op: dict[str, Any]) -> None:
    body, objs = _originals(ctx, op)
    obj = _new_transformed(ctx, body, "PartDesign::PolarPattern", objs)
    axis, reverse = _axis_reference(body, op["axis"])
    obj.Axis = (axis, [""])
    obj.Reversed = reverse
    ctx.set_value(obj, "Angle", op["angle"])
    obj.Occurrences = int(op["count"])
    ctx.register(obj, op["name"])


def mirror(ctx: Any, op: dict[str, Any]) -> None:
    body, objs = _originals(ctx, op)
    obj = _new_transformed(ctx, body, "PartDesign::Mirrored", objs)
    obj.MirrorPlane = (origin_feature(body, {"XY": "XY_Plane", "XZ": "XZ_Plane", "YZ": "YZ_Plane"}[op["plane"]]), [""])
    ctx.register(obj, op["name"])
