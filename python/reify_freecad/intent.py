"""Requirement ("intent") objects and their evaluation (imports FreeCAD)."""

from __future__ import annotations

import json
from typing import Any

from .core import REQUIREMENTS_NAME, bodies, get_path, path_index
from .errors import ReifyOpError
from .queries import Budget, clearance, mass, shape_of, wall_thickness

_GROUP = "Requirement"


def require(ctx: Any, op: dict[str, Any]) -> None:
    kind = op["kind"]
    _validate(kind, op["target"], op["limit"])
    group = ctx.session.requirements_group(create=True)
    item = ctx.doc.addObject("App::VarSet", "Requirement")
    group.addObject(item)
    ctx.register(item, op["name"])
    item.addProperty("App::PropertyString", "Kind", _GROUP)
    item.addProperty("App::PropertyString", "Target", _GROUP)
    item.addProperty("App::PropertyString", "Limit", _GROUP)
    item.addProperty("App::PropertyFloat", "Tolerance", _GROUP)
    item.Kind = kind
    item.Target = json.dumps(op["target"])
    item.Limit = json.dumps(op["limit"])
    item.Tolerance = float(op.get("tolerance", 0.0)) if not isinstance(op.get("tolerance"), str) else 0.0


def _bad(path: str, reason: str) -> ReifyOpError:
    return ReifyOpError("OP_SCHEMA_INVALID", f"require: {path}: {reason}", detail={"path": path, "reason": reason})


def _validate(kind: str, target: Any, limit: Any) -> None:
    number = isinstance(limit, (int, float)) and not isinstance(limit, bool)
    if kind in {"min_wall", "min_clearance", "max_mass", "dimension"} and not number:
        raise _bad("limit", "expected a number")
    if kind == "bbox_within" and not (isinstance(limit, list) and len(limit) == 3 and all(isinstance(v, (int, float)) for v in limit)):
        raise _bad("limit", "expected [x, y, z]")
    if kind == "min_clearance" and not (isinstance(target, dict) and {"a", "b"} <= set(target)):
        raise _bad("target", "expected {a: path, b: path}")
    if kind == "dimension" and not (isinstance(target, dict) and {"target", "prop"} <= set(target)):
        raise _bad("target", "expected {target: path, prop: name}")
    if kind in {"min_wall", "bbox_within"} and not isinstance(target, str):
        raise _bad("target", "expected a path")
    if kind == "max_mass" and target is not None and not isinstance(target, str):
        raise _bad("target", "expected a path or null")


def evaluate_all(ctx: Any) -> list[dict[str, Any]]:
    group = ctx.session.requirements_group(create=False)
    if group is None:
        return []
    results = []
    for item in group.Group:
        path = get_path(item) or item.Label
        try:
            results.append(_evaluate(ctx, path, item))
        except ReifyOpError as error:
            results.append({"path": path, "kind": item.Kind, "status": "error", "error": error.code, "message": error.message})
    return results


def _evaluate(ctx: Any, path: str, item: Any) -> dict[str, Any]:
    kind = item.Kind
    target = json.loads(item.Target)
    limit = json.loads(item.Limit)
    tolerance = float(item.Tolerance)
    base = {"path": path, "kind": kind, "limit": limit}
    if kind == "min_wall":
        value = wall_thickness(ctx, target, 200, Budget(20))["value"]
        return {**base, "value": value, "status": "pass" if value >= limit - tolerance else "fail"}
    if kind == "min_clearance":
        value = clearance(ctx, target["a"], target["b"])["value"]
        return {**base, "value": value, "status": "pass" if value >= limit - tolerance else "fail"}
    if kind == "max_mass":
        value = mass(ctx, target, None)["value"]
        return {**base, "value": value, "status": "pass" if value <= limit + tolerance else "fail"}
    if kind == "bbox_within":
        box = shape_of(ctx, target).BoundBox
        size = [round(box.XLength, 4), round(box.YLength, 4), round(box.ZLength, 4)]
        ok = all(s <= l + tolerance for s, l in zip(size, limit))
        return {**base, "value": size, "status": "pass" if ok else "fail"}
    if kind == "dimension":
        obj = path_index(ctx.doc).get(target["target"])
        if obj is None or target["prop"] not in obj.PropertiesList:
            raise ReifyOpError("TARGET_NOT_FOUND", f"no property {target['prop']} on {target['target']}", target=target["target"], detail={"target": target, "known": []})
        raw = getattr(obj, target["prop"])
        value = round(float(raw.Value if hasattr(raw, "Value") else raw), 6)
        return {**base, "value": value, "status": "pass" if abs(value - limit) <= max(tolerance, 1e-6) else "fail"}
    raise ReifyOpError("OP_SCHEMA_INVALID", f"unknown requirement kind {kind}", detail={"path": "kind", "reason": "unknown"})
