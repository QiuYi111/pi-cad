"""``body`` and ``placement`` ops: multi-body documents and poses (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

import FreeCAD as App

from ..assembly import is_unit_container
from ..core import is_body
from ..errors import ReifyOpError
from ..exprs import evaluate_constant, is_expression, rewrite_expression


def body(ctx: Any, op: dict[str, Any]) -> None:
    created = ctx.doc.addObject("PartDesign::Body", "Body")
    ctx.register(created, op["name"])
    ctx.current_body = created


def placement(ctx: Any, op: dict[str, Any]) -> None:
    obj = ctx.lookup(op["target"])
    if not (is_body(obj) or is_unit_container(obj)):
        raise ReifyOpError("OP_SCHEMA_INVALID", f"'{op['target']}' is not a body or an occurrence; poses are set on those",
                           detail={"path": "target", "reason": "not a body or occurrence"})
    set_pose(ctx, obj, op)


def set_pose(ctx: Any, obj: Any, op: dict[str, Any]) -> None:
    position = op.get("position")
    rotation = op.get("rotation")
    base = obj.Placement.Base
    current_rotation = obj.Placement.Rotation
    if position is not None:
        base = App.Vector(*[evaluate_constant(v) or 0.0 for v in position])
    if rotation is not None:
        axis = App.Vector(*[evaluate_constant(v) or 0.0 for v in rotation["axis"]])
        angle = evaluate_constant(rotation["angle"]) or 0.0
        current_rotation = App.Rotation(axis, angle)
    obj.Placement = App.Placement(base, current_rotation)
    if position is not None:
        for axis_name, value in zip("xyz", position):
            if is_expression(value):
                obj.setExpression(f"Placement.Base.{axis_name}", rewrite_expression(value, ctx.known_params))
    if rotation is not None and is_expression(rotation["angle"]):
        obj.setExpression("Placement.Rotation.Angle", rewrite_expression(rotation["angle"], ctx.known_params))
