"""``param`` op: named values on the Params VarSet (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

from ..errors import ReifyOpError
from ..exprs import is_expression, rewrite_expression

_TYPES = {"mm": "App::PropertyLength", "deg": "App::PropertyAngle", None: "App::PropertyFloat"}
_GROUP = "Params"


def param(ctx: Any, op: dict[str, Any]) -> None:
    session = ctx.session
    vs = session.params_object()
    name = op["name"]
    unit = op.get("unit")
    wanted = _TYPES[unit]
    exists = name in vs.PropertiesList and vs.getGroupOfProperty(name) == _GROUP
    if name in vs.PropertiesList and not exists:
        raise ReifyOpError("NAME_CONFLICT", f"'{name}' is a reserved property name", target=name)
    if exists and unit is None:
        wanted = vs.getTypeIdOfProperty(name)  # keep the existing unit when none is given
    if exists and vs.getTypeIdOfProperty(name) != wanted:
        try:
            vs.setExpression(name, None)
        except Exception:
            pass
        vs.removeProperty(name)
        exists = False
    if not exists:
        vs.addProperty(wanted, name, _GROUP, "Parameter (Pi-CAD)")
    value = op["value"]
    if is_expression(value):
        vs.setExpression(name, rewrite_expression(value, session.param_names() - {name}))
    else:
        try:
            vs.setExpression(name, None)
        except Exception:
            pass
        setattr(vs, name, float(value))
