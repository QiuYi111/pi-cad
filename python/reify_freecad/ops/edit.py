"""``set``, ``delete`` and ``rename`` ops (imports FreeCAD)."""

from __future__ import annotations

import json
from typing import Any

import FreeCAD as App

from ..core import PARAMS_NAME, PATH_PROPERTY, bodies, get_path, is_body, is_feature, is_sketch, set_path
from ..errors import ReifyOpError
from ..exprs import PARAMS_OBJECT, is_expression, rewrite_expression
from ..naming import check_not_role_name
from .schema import SETTABLE_PROPS

# set prop -> real property per feature type
_ALIASES = {
    ("PartDesign::Pocket", "Depth"): "Length",
    ("PartDesign::Pad", "Depth"): "Length",
    ("PartDesign::Fillet", "Size"): "Radius",
    ("PartDesign::Chamfer", "Radius"): "Size",
}
_TYPE_VALUES = {
    "PartDesign::Pad": {"length": "Length", "through_all": "UpToLast", "up_to_face": "UpToFace"},
    "PartDesign::Pocket": {"length": "Length", "through_all": "ThroughAll"},
    "PartDesign::Hole": {"blind": "Dimension", "through_all": "ThroughAll"},
}
_BOOLEAN_PROPS = {"Reversed", "Midplane"}


def _allowed(ctx: Any) -> list[str]:
    return [*SETTABLE_PROPS, "constraint:<name>", *sorted(ctx.known_params)]


def set_prop(ctx: Any, op: dict[str, Any]) -> None:
    obj = ctx.lookup(op["target"])
    prop, value = op["prop"], op["value"]
    if obj.Name == PARAMS_NAME or get_path(obj) == PARAMS_OBJECT:
        if prop not in ctx.known_params:
            raise ReifyOpError("PROP_NOT_ALLOWED", f"'{prop}' is not a parameter", target=op["target"],
                               detail={"allowed": _allowed(ctx)})
        ctx.set_value(obj, prop, value)
        return
    if prop.startswith("constraint:"):
        _set_constraint(ctx, obj, prop.split(":", 1)[1], value, op["target"])
        return
    if prop not in SETTABLE_PROPS:
        raise ReifyOpError("PROP_NOT_ALLOWED", f"'{prop}' cannot be set", target=op["target"], detail={"allowed": _allowed(ctx)})
    real = _ALIASES.get((obj.TypeId, prop), prop)
    if real not in obj.PropertiesList:
        raise ReifyOpError("PROP_NOT_ALLOWED", f"{op['target']} has no property '{prop}'", target=op["target"],
                           detail={"allowed": [p for p in SETTABLE_PROPS if p in obj.PropertiesList]})
    if real in _BOOLEAN_PROPS:
        if not isinstance(value, bool):
            raise ReifyOpError("OP_SCHEMA_INVALID", f"{prop} expects true or false", detail={"path": "value", "reason": "not a bool"})
        setattr(obj, real, value)
    elif real == "Type":
        table = _TYPE_VALUES.get(obj.TypeId, {})
        if value not in table:
            raise ReifyOpError("OP_SCHEMA_INVALID", f"Type for {obj.TypeId} must be one of {sorted(table)}", detail={"path": "value", "reason": "bad type"})
        obj.Type = table[value]
    elif real == "Occurrences":
        obj.Occurrences = int(value)
    else:
        ctx.set_value(obj, real, value)


def _set_constraint(ctx: Any, sketch: Any, name: str, value: Any, target: str) -> None:
    if not is_sketch(sketch):
        raise ReifyOpError("PROP_NOT_ALLOWED", f"{target} is not a sketch", target=target, detail={"allowed": _allowed(ctx)})
    names = [c.Name for c in sketch.Constraints if c.Name]
    if name not in names:
        raise ReifyOpError("TARGET_NOT_FOUND", f"sketch {target} has no named constraint '{name}'", target=target, detail={"target": name, "known": names[:20]})
    if is_expression(value):
        sketch.setExpression(f"Constraints.{name}", rewrite_expression(value, ctx.known_params))
        return
    try:
        sketch.setExpression(f"Constraints.{name}", None)
    except Exception:
        pass
    constraint = next(c for c in sketch.Constraints if c.Name == name)
    unit = "deg" if constraint.Type == "Angle" else "mm"
    sketch.setDatum(name, App.Units.Quantity(f"{float(value)} {unit}"))


def delete(ctx: Any, op: dict[str, Any]) -> None:
    target = op["target"]
    obj = ctx.lookup(target)
    if get_path(obj) == PARAMS_OBJECT:
        raise ReifyOpError("PROP_NOT_ALLOWED", "the Params object cannot be deleted", target=target, detail={"allowed": []})
    dependents = []
    for other in obj.InList:
        path = get_path(other)
        if path and not is_body(other) and other.TypeId != "App::DocumentObjectGroup":
            dependents.append(path)
    if is_body(obj):
        dependents.extend(p for p in (get_path(o) for o in obj.Group) if p)
    if dependents:
        raise ReifyOpError("HAS_DEPENDENTS", f"'{target}' is used by {len(dependents)} other object(s)", target=target,
                           detail={"dependents": sorted(set(dependents))}, hints=["delete the dependents first"])
    owner = None
    for body in bodies(ctx.doc):
        if obj in body.Group:
            owner = body
    if owner is not None:
        owner.removeObject(obj)
    ctx.doc.removeObject(obj.Name)


def rename(ctx: Any, op: dict[str, Any]) -> None:
    old, new = op["target"], op["to"]
    index = ctx.index()
    if old not in index:
        ctx.lookup(old)
    if old == PARAMS_OBJECT:
        raise ReifyOpError("PROP_NOT_ALLOWED", "the Params object cannot be renamed", target=old, detail={"allowed": []})
    moved = {path: obj for path, obj in index.items() if path == old or path.startswith(old + "/")}
    for path in moved:
        replacement = new + path[len(old):]
        if replacement in index and replacement not in moved:
            raise ReifyOpError("NAME_CONFLICT", f"'{replacement}' already exists", target=replacement, hints=["pick another name"])
    check_not_role_name(new)
    for path, obj in moved.items():
        set_path(obj, new + path[len(old):])
    _rewrite_requirement_targets(ctx, old, new)


def _rewrite_requirement_targets(ctx: Any, old: str, new: str) -> None:
    group = ctx.session.requirements_group(create=False)
    if group is None:
        return
    for item in group.Group:
        if "Target" not in item.PropertiesList:
            continue
        text = item.Target
        if old in text:
            item.Target = text.replace(f'"{old}', f'"{new}')
