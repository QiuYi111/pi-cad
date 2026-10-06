"""Numbers and ``=expression`` strings (pure Python).

A value is a number or a string starting with ``=``. Names inside an
expression refer to parameters on the ``Params`` VarSet; they are rewritten
to ``Params.<name>`` before FreeCAD sees them.
"""

from __future__ import annotations

import re
from typing import Any

from .errors import ReifyOpError

PARAMS_OBJECT = "Params"
_IDENTIFIER = re.compile(r"(?<![\w.])([A-Za-z_][A-Za-z_0-9]*)(?!\s*\()")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
#: Units and constants FreeCAD expressions know; never rewritten.
_KEEP = frozenset({
    "mm", "cm", "m", "km", "um", "in", "ft", "deg", "rad", "pi", "e",
    "Params", "Constraints", "Spreadsheet",
})


def is_expression(value: Any) -> bool:
    return isinstance(value, str) and value.lstrip().startswith("=")


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def check_param_name(name: Any) -> str:
    if not isinstance(name, str) or not _NAME.match(name):
        raise ReifyOpError(
            "OP_SCHEMA_INVALID",
            f"parameter name {name!r} must match [A-Za-z_][A-Za-z0-9_]*",
            detail={"path": "name", "reason": "not an identifier"},
        )
    return name


def rewrite_expression(expression: str, known_params: set[str] | frozenset[str]) -> str:
    """``"=width/2"`` -> ``"Params.width/2"``; unknown names raise EXPRESSION_INVALID."""
    body = expression.strip()[1:].strip()
    if not body:
        raise ReifyOpError("EXPRESSION_INVALID", "empty expression", detail={"expression": expression, "reason": "empty"})
    unknown: list[str] = []

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in _KEEP:
            return name
        # A unit directly after a number ("20 mm") was handled by _KEEP; any other
        # bare word must be a declared parameter.
        if name in known_params:
            return f"{PARAMS_OBJECT}.{name}"
        unknown.append(name)
        return name

    rewritten = _IDENTIFIER.sub(replace, body)
    if unknown:
        raise ReifyOpError(
            "EXPRESSION_INVALID",
            f"unknown parameter {unknown[0]!r} in expression {expression!r}",
            detail={"expression": expression, "reason": f"unknown parameter {unknown[0]}", "known": sorted(known_params)[:20]},
            hints=["declare it first with a param op"],
        )
    return rewritten


def value_as_expression(value: Any, known_params: set[str] | frozenset[str], unit: str | None = None) -> str:
    """Expression text for any value: numbers become literals (with ``unit`` when given)."""
    if is_expression(value):
        return rewrite_expression(value, known_params)
    if is_number(value):
        return f"{float(value)!r} {unit}" if unit else repr(float(value))
    raise ReifyOpError("OP_SCHEMA_INVALID", f"expected a number or '=expression', got {value!r}", detail={"reason": "not a number"})


def evaluate_constant(value: Any) -> float | None:
    """The number when ``value`` is a plain number; None for expressions."""
    return float(value) if is_number(value) else None
