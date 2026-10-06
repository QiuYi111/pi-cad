"""Operation schemas and validation (pure Python).

Every op is a JSON object with an ``op`` key. Validation never touches
FreeCAD, so a malformed batch is rejected before a transaction opens.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from ..errors import ReifyOpError
from ..exprs import check_param_name, is_expression, is_number
from ..naming import checked_path

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PLANES = ("XY", "XZ", "YZ")
AXES = ("X", "Y", "Z", "-X", "-Y", "-Z")
REQUIRE_KINDS = ("min_wall", "min_clearance", "max_mass", "bbox_within", "dimension")
#: Properties ``set`` may change, besides Params attributes and ``constraint:<name>``.
SETTABLE_PROPS = (
    "Length", "Length2", "Depth", "Diameter", "Radius", "Size", "Occurrences", "Angle",
    "Reversed", "Midplane", "Type",
)


def fail(index: int | None, path: str, reason: str) -> ReifyOpError:
    return ReifyOpError(
        "OP_SCHEMA_INVALID",
        f"op {index if index is not None else '?'}: {path}: {reason}",
        detail={"opIndex": index, "path": path, "reason": reason},
    )


Check = Callable[[Any, int | None, str], Any]


def c_path(value: Any, index: int | None, where: str) -> str:
    return checked_path(value, op_index=index, field=where)


def c_value(value: Any, index: int | None, where: str) -> Any:
    if is_number(value) or is_expression(value):
        return value
    raise fail(index, where, f"expected a number or '=expression', got {value!r}")


def c_positive_int(value: Any, index: int | None, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise fail(index, where, f"expected an integer >= 1, got {value!r}")
    return value


def c_bool(value: Any, index: int | None, where: str) -> bool:
    if not isinstance(value, bool):
        raise fail(index, where, f"expected true or false, got {value!r}")
    return value


def c_str(value: Any, index: int | None, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise fail(index, where, f"expected a non-empty string, got {value!r}")
    return value


def c_enum(*choices: str) -> Check:
    def check(value: Any, index: int | None, where: str) -> str:
        if value not in choices:
            raise fail(index, where, f"expected one of {list(choices)}, got {value!r}")
        return value
    return check


def c_vec2(value: Any, index: int | None, where: str) -> list[Any]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise fail(index, where, "expected [x, y]")
    return [c_value(item, index, f"{where}[{i}]") for i, item in enumerate(value)]


def c_selector(value: Any, index: int | None, where: str) -> dict[str, Any]:
    """``{"feature", "role"}`` or ``{"between": [selector, selector]}``."""
    if not isinstance(value, dict):
        raise fail(index, where, "expected a selector object")
    if "between" in value:
        pair = value["between"]
        if not isinstance(pair, list) or len(pair) != 2:
            raise fail(index, f"{where}.between", "expected two selectors")
        return {"between": [c_selector(item, index, f"{where}.between[{i}]") for i, item in enumerate(pair)]}
    if "feature" not in value:
        raise fail(index, where, "selector needs 'feature' (and 'role') or 'between'")
    unknown = set(value) - {"feature", "role"}
    if unknown:
        raise fail(index, where, f"unknown selector keys {sorted(unknown)}")
    selector: dict[str, Any] = {"feature": c_path(value["feature"], index, f"{where}.feature")}
    if "role" in value:
        selector["role"] = c_str(value["role"], index, f"{where}.role")
    return selector


def c_selectors(value: Any, index: int | None, where: str) -> list[dict[str, Any]]:
    items = value if isinstance(value, list) else [value]
    if not items:
        raise fail(index, where, "expected at least one selector")
    return [c_selector(item, index, f"{where}[{i}]") for i, item in enumerate(items)]


def c_pathlist(value: Any, index: int | None, where: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise fail(index, where, "expected a non-empty list of paths")
    return [c_path(item, index, f"{where}[{i}]") for i, item in enumerate(value)]


def c_constraint_name(value: Any, index: int | None, where: str) -> str:
    if not isinstance(value, str) or not _IDENT.match(value):
        raise fail(index, where, f"expected an identifier, got {value!r}")
    return value


def c_points(value: Any, index: int | None, where: str) -> list[list[Any]]:
    if not isinstance(value, list) or len(value) < 2:
        raise fail(index, where, "expected at least two [x, y] points")
    return [c_vec2(point, index, f"{where}[{k}]") for k, point in enumerate(value)]


def c_vec3(value: Any, index: int | None, where: str) -> list[Any]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise fail(index, where, "expected [x, y, z]")
    return [c_value(item, index, f"{where}[{k}]") for k, item in enumerate(value)]


def c_rotation(value: Any, index: int | None, where: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"axis", "angle"}:
        raise fail(index, where, "expected {axis: [x, y, z], angle: value}")
    return {"axis": c_vec3(value["axis"], index, f"{where}.axis"), "angle": c_value(value["angle"], index, f"{where}.angle")}


_SHAPE_FIELDS: dict[str, tuple[dict[str, Check], dict[str, Check]]] = {
    "rect": ({"size": c_vec2}, {"center": c_vec2, "corner": c_vec2, "name": c_constraint_name}),
    "circle": ({"center": c_vec2, "diameter": c_value}, {"name": c_constraint_name}),
    "slot": ({"start": c_vec2, "end": c_vec2, "width": c_value}, {"name": c_constraint_name}),
    "polyline": ({"points": c_points}, {"closed": c_bool, "name": c_constraint_name}),
    "point": ({"at": c_vec2}, {"name": c_constraint_name}),
}


def check_shape(shape: Any, index: int | None, where: str) -> dict[str, Any]:
    if not isinstance(shape, dict) or len(shape) != 1:
        raise fail(index, where, "each shape is an object with exactly one key (rect, circle, slot, polyline, point)")
    ((kind, body),) = shape.items()
    if kind not in _SHAPE_FIELDS:
        raise fail(index, where, f"unknown shape {kind!r}; supported: {sorted(_SHAPE_FIELDS)}")
    if not isinstance(body, dict):
        raise fail(index, f"{where}.{kind}", "expected an object")
    required, optional = _SHAPE_FIELDS[kind]
    out: dict[str, Any] = {}
    for key, check in required.items():
        if key not in body:
            raise fail(index, f"{where}.{kind}.{key}", "required")
        out[key] = check(body[key], index, f"{where}.{kind}.{key}")
    for key, check in optional.items():
        if key in body:
            out[key] = check(body[key], index, f"{where}.{kind}.{key}")
    unknown = set(body) - set(required) - set(optional)
    if unknown:
        raise fail(index, f"{where}.{kind}", f"unknown keys {sorted(unknown)}")
    if kind == "rect" and ("center" in out) == ("corner" in out):
        raise fail(index, f"{where}.rect", "give exactly one of 'center' or 'corner'")
    return {kind: out}


def c_shapes(value: Any, index: int | None, where: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise fail(index, where, "expected a non-empty list of shapes")
    return [check_shape(item, index, f"{where}[{i}]") for i, item in enumerate(value)]


def c_any(value: Any, index: int | None, where: str) -> Any:
    return value


def c_attach(value: Any, index: int | None, where: str) -> dict[str, Any]:
    return c_selector(value, index, where)


# op -> (required fields, optional fields)
SCHEMAS: dict[str, tuple[dict[str, Check], dict[str, Check]]] = {
    "param": ({"name": lambda v, i, w: check_param_name(v), "value": c_value}, {"unit": c_enum("mm", "deg")}),
    "body": ({"name": c_path}, {}),
    "sketch": (
        {"name": c_path, "shapes": c_shapes},
        {"plane": c_enum(*PLANES), "offset": c_value, "on": c_attach, "body": c_path},
    ),
    "pad": (
        {"name": c_path, "sketch": c_path, "length": c_value},
        {"reversed": c_bool, "midplane": c_bool, "type": c_enum("length", "through_all", "up_to_face"), "face": c_selector, "body": c_path},
    ),
    "pocket": (
        {"name": c_path, "sketch": c_path, "depth": c_value},
        {"type": c_enum("length", "through_all"), "reversed": c_bool, "body": c_path},
    ),
    "hole": (
        {"name": c_path, "sketch": c_path, "diameter": c_value},
        {"depth": c_value, "type": c_enum("blind", "through_all"), "thread": c_str,
         "counterbore": c_any, "countersink": c_any, "body": c_path},
    ),
    "fillet": ({"name": c_path, "edges": c_selectors, "radius": c_value}, {"body": c_path}),
    "chamfer": ({"name": c_path, "edges": c_selectors, "size": c_value}, {"body": c_path}),
    "linear_pattern": (
        {"name": c_path, "features": c_pathlist, "direction": c_enum(*AXES), "length": c_value, "count": c_positive_int},
        {"body": c_path},
    ),
    "polar_pattern": (
        {"name": c_path, "features": c_pathlist, "axis": c_enum(*AXES), "angle": c_value, "count": c_positive_int},
        {"body": c_path},
    ),
    "mirror": ({"name": c_path, "features": c_pathlist, "plane": c_enum(*PLANES)}, {"body": c_path}),
    "set": ({"target": c_path, "prop": c_str, "value": c_any}, {}),
    "delete": ({"target": c_path}, {}),
    "rename": ({"target": c_path, "to": c_path}, {}),
    "placement": (
        {"target": c_path},
        {"position": c_vec3, "rotation": c_rotation},
    ),
    "require": (
        {"name": c_path, "kind": c_enum(*REQUIRE_KINDS), "target": c_any, "limit": c_any},
        {"tolerance": c_value},
    ),
}

#: Ops that add or change geometry, in the order they are listed in documentation.
OP_NAMES = tuple(SCHEMAS)


def validate_op(op: Any, index: int | None = None) -> dict[str, Any]:
    """Return a normalised copy of ``op`` (canonical paths) or raise OP_SCHEMA_INVALID."""
    if not isinstance(op, dict):
        raise fail(index, "op", "expected an object")
    kind = op.get("op")
    if kind not in SCHEMAS:
        raise fail(index, "op", f"unknown op {kind!r}; supported: {list(SCHEMAS)}")
    required, optional = SCHEMAS[kind]
    out: dict[str, Any] = {"op": kind}
    for key, check in required.items():
        if key not in op:
            raise fail(index, key, "required")
        out[key] = check(op[key], index, key)
    for key, check in optional.items():
        if key in op:
            out[key] = check(op[key], index, key)
    unknown = set(op) - {"op"} - set(required) - set(optional)
    if unknown:
        raise fail(index, "op", f"unknown keys {sorted(unknown)} for {kind}")
    if kind == "sketch" and "plane" not in out and "on" not in out:
        raise fail(index, "plane", "give 'plane' (XY, XZ, YZ) or 'on' (a face selector)")
    if kind == "pad" and out.get("type") == "up_to_face" and "face" not in out:
        raise fail(index, "face", "required when type is up_to_face")
    if kind == "hole" and out.get("type", "blind") == "blind" and "depth" not in out:
        raise fail(index, "depth", "required for a blind hole")
    if kind == "set" and not isinstance(out["prop"], str):
        raise fail(index, "prop", "expected a string")
    return out


def validate_ops(ops: Any) -> list[dict[str, Any]]:
    if not isinstance(ops, list) or not ops:
        raise fail(None, "ops", "expected a non-empty list of ops")
    return [validate_op(item, index) for index, item in enumerate(ops)]
