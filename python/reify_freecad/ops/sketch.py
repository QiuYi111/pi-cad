"""``sketch`` op: JSON shapes -> fully constrained sketch (imports FreeCAD)."""

from __future__ import annotations

import math
from typing import Any

import FreeCAD as App
import Part
import Sketcher

from ..core import origin_feature
from ..errors import ReifyOpError
from ..exprs import evaluate_constant, is_expression, value_as_expression

#: FreeCAD sketch geometry point positions.
START, END, CENTER = 1, 2, 3
ORIGIN = (-1, 1)  # (geometry id, position) of the sketch origin


def _signed(sketch: Any, kind: str, first: tuple[int, int], second: tuple[int, int], value: float, name: str | None) -> int:
    index = sketch.addConstraint(Sketcher.Constraint(kind, first[0], first[1], second[0], second[1], value))
    if name:
        sketch.renameConstraint(index, name)
    return index


def _expr_sum(ctx: Any, *terms: tuple[float, Any]) -> tuple[float | None, str | None]:
    """sum(sign * value) as a number when every term is constant, else an expression."""
    constants = [(sign, evaluate_constant(value)) for sign, value in terms]
    if all(c is not None for _s, c in constants):
        return sum(sign * c for sign, c in constants), None  # type: ignore[operator]
    parts = []
    for sign, value in terms:
        text = value_as_expression(value, ctx.known_params, "mm")
        parts.append(f"({sign:g}) * ({text})")
    first = sum(sign * (evaluate_constant(value) or 0.0) for sign, value in terms)
    return first, " + ".join(parts)


def _bind(sketch: Any, index: int, name: str, expression: str | None) -> None:
    if expression is not None:
        sketch.setExpression(f"Constraints.{name}", expression)


def _fix_point(ctx: Any, sketch: Any, point: tuple[int, int], x: Any, y: Any, prefix: str,
               offsets: tuple[tuple[float, Any] | None, tuple[float, Any] | None] = (None, None)) -> None:
    """Pin ``point`` at (x + dx, y + dy) from the sketch origin with named DistanceX/Y constraints."""
    for axis, kind, value, extra in (("x", "DistanceX", x, offsets[0]), ("y", "DistanceY", y, offsets[1])):
        terms = [(1.0, value)] + ([extra] if extra else [])
        number, expression = _expr_sum(ctx, *terms)
        name = f"{prefix}_{axis}"
        index = sketch.addConstraint(Sketcher.Constraint(kind, ORIGIN[0], ORIGIN[1], point[0], point[1], number))
        sketch.renameConstraint(index, name)
        _bind(sketch, index, name, expression)


def _dimension(ctx: Any, sketch: Any, kind: str, args: tuple, value: Any, name: str, scale: float = 1.0) -> None:
    number, expression = _expr_sum(ctx, (scale, value))
    index = sketch.addConstraint(Sketcher.Constraint(kind, *args, number))
    sketch.renameConstraint(index, name)
    _bind(sketch, index, name, expression)


def _rect(ctx: Any, sketch: Any, spec: dict[str, Any], prefix: str) -> None:
    width, height = spec["size"]
    w, h = evaluate_constant(width), evaluate_constant(height)
    if "center" in spec:
        cx, cy = spec["center"]
        x0 = (evaluate_constant(cx) or 0.0) - (w or 1.0) / 2
        y0 = (evaluate_constant(cy) or 0.0) - (h or 1.0) / 2
        corner_offset = ((-0.5, width), (-0.5, height))
        base_x, base_y = cx, cy
    else:
        base_x, base_y = spec["corner"]
        x0, y0 = evaluate_constant(base_x) or 0.0, evaluate_constant(base_y) or 0.0
        corner_offset = (None, None)
    w_num = w if w is not None else 1.0
    h_num = h if h is not None else 1.0
    pts = [App.Vector(x0, y0, 0), App.Vector(x0 + w_num, y0, 0), App.Vector(x0 + w_num, y0 + h_num, 0), App.Vector(x0, y0 + h_num, 0)]
    first = sketch.GeometryCount
    for i in range(4):
        sketch.addGeometry(Part.LineSegment(pts[i], pts[(i + 1) % 4]), False)
    ids = [first + i for i in range(4)]
    for i in range(4):
        sketch.addConstraint(Sketcher.Constraint("Coincident", ids[i], END, ids[(i + 1) % 4], START))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", ids[0]))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", ids[2]))
    sketch.addConstraint(Sketcher.Constraint("Vertical", ids[1]))
    sketch.addConstraint(Sketcher.Constraint("Vertical", ids[3]))
    _dimension(ctx, sketch, "DistanceX", (ids[0], START, ids[0], END), width, f"{prefix}_w")
    _dimension(ctx, sketch, "DistanceY", (ids[1], START, ids[1], END), height, f"{prefix}_h")
    _fix_point(ctx, sketch, (ids[0], START), base_x, base_y, f"{prefix}_c" if "center" in spec else f"{prefix}_p", corner_offset)


def _circle(ctx: Any, sketch: Any, spec: dict[str, Any], prefix: str) -> None:
    cx, cy = spec["center"]
    diameter = spec["diameter"]
    radius = (evaluate_constant(diameter) or 2.0) / 2
    index = sketch.addGeometry(Part.Circle(App.Vector(evaluate_constant(cx) or 0.0, evaluate_constant(cy) or 0.0, 0), App.Vector(0, 0, 1), radius), False)
    _dimension(ctx, sketch, "Diameter", (index,), diameter, f"{prefix}_d")
    _fix_point(ctx, sketch, (index, CENTER), cx, cy, f"{prefix}_c")


def _point(ctx: Any, sketch: Any, spec: dict[str, Any], prefix: str) -> None:
    x, y = spec["at"]
    index = sketch.addGeometry(Part.Point(App.Vector(evaluate_constant(x) or 0.0, evaluate_constant(y) or 0.0, 0)), False)
    _fix_point(ctx, sketch, (index, START), x, y, f"{prefix}_p")


def _polyline(ctx: Any, sketch: Any, spec: dict[str, Any], prefix: str) -> None:
    points = spec["points"]
    closed = spec.get("closed", False)
    numeric = [(evaluate_constant(x) or 0.0, evaluate_constant(y) or 0.0) for x, y in points]
    count = len(points)
    segments = count if closed else count - 1
    first = sketch.GeometryCount
    for i in range(segments):
        a, b = numeric[i], numeric[(i + 1) % count]
        sketch.addGeometry(Part.LineSegment(App.Vector(a[0], a[1], 0), App.Vector(b[0], b[1], 0)), False)
    for i in range(segments - 1):
        sketch.addConstraint(Sketcher.Constraint("Coincident", first + i, END, first + i + 1, START))
    if closed:
        sketch.addConstraint(Sketcher.Constraint("Coincident", first + segments - 1, END, first, START))
    for i, (x, y) in enumerate(points[:segments]):
        _fix_point(ctx, sketch, (first + i, START), x, y, f"{prefix}_p{i}")
    if not closed:
        x, y = points[-1]
        _fix_point(ctx, sketch, (first + segments - 1, END), x, y, f"{prefix}_p{count - 1}")


def _slot(ctx: Any, sketch: Any, spec: dict[str, Any], prefix: str) -> None:
    (sx, sy), (ex, ey) = spec["start"], spec["end"]
    width = spec["width"]
    p1 = (evaluate_constant(sx) or 0.0, evaluate_constant(sy) or 0.0)
    p2 = (evaluate_constant(ex) or 0.0, evaluate_constant(ey) or 0.0)
    r = (evaluate_constant(width) or 2.0) / 2
    theta = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    nx, ny = -math.sin(theta), math.cos(theta)
    v = lambda p, k: App.Vector(p[0] + k * r * nx, p[1] + k * r * ny, 0)  # noqa: E731
    first = sketch.GeometryCount
    bottom = sketch.addGeometry(Part.LineSegment(v(p1, -1), v(p2, -1)), False)
    arc_end = sketch.addGeometry(Part.ArcOfCircle(Part.Circle(App.Vector(p2[0], p2[1], 0), App.Vector(0, 0, 1), r), theta - math.pi / 2, theta + math.pi / 2), False)
    top = sketch.addGeometry(Part.LineSegment(v(p2, 1), v(p1, 1)), False)
    arc_start = sketch.addGeometry(Part.ArcOfCircle(Part.Circle(App.Vector(p1[0], p1[1], 0), App.Vector(0, 0, 1), r), theta + math.pi / 2, theta + 3 * math.pi / 2), False)
    del first
    sketch.addConstraint(Sketcher.Constraint("Tangent", bottom, END, arc_end, START))
    sketch.addConstraint(Sketcher.Constraint("Tangent", arc_end, END, top, START))
    sketch.addConstraint(Sketcher.Constraint("Tangent", top, END, arc_start, START))
    sketch.addConstraint(Sketcher.Constraint("Tangent", arc_start, END, bottom, START))
    sketch.addConstraint(Sketcher.Constraint("Equal", arc_end, arc_start))
    _dimension(ctx, sketch, "Radius", (arc_end,), width, f"{prefix}_r", scale=0.5)
    _fix_point(ctx, sketch, (arc_start, CENTER), sx, sy, f"{prefix}_a")
    _fix_point(ctx, sketch, (arc_end, CENTER), ex, ey, f"{prefix}_b")


_BUILDERS = {"rect": _rect, "circle": _circle, "slot": _slot, "polyline": _polyline, "point": _point}


def resolve_plane_support(ctx: Any, body: Any, op: dict[str, Any]) -> tuple[Any, str]:
    if "on" in op:
        from ..roles import resolve_single_face

        owner, face_name = resolve_single_face(ctx, op["on"])
        return owner, face_name
    return origin_feature(body, {"XY": "XY_Plane", "XZ": "XZ_Plane", "YZ": "YZ_Plane"}[op["plane"]]), ""


def build_sketch(ctx: Any, body: Any, op: dict[str, Any]) -> Any:
    sketch = body.newObject("Sketcher::SketchObject", "Sketch")
    support, element = resolve_plane_support(ctx, body, op)
    sketch.AttachmentSupport = [(support, element)]
    sketch.MapMode = "FlatFace"
    if "offset" in op:
        offset = op["offset"]
        sketch.AttachmentOffset = App.Placement(App.Vector(0, 0, evaluate_constant(offset) or 0.0), App.Rotation())
        if is_expression(offset):
            sketch.setExpression("AttachmentOffset.Base.z", value_as_expression(offset, ctx.known_params))
    for index, shape in enumerate(op["shapes"]):
        ((kind, spec),) = shape.items()
        prefix = spec.get("name") or f"s{index}"
        try:
            _BUILDERS[kind](ctx, sketch, spec, prefix)
        except ReifyOpError:
            raise
        except Exception as error:  # degenerate geometry (zero length, equal points, ...)
            raise ReifyOpError(
                "SKETCH_MALFORMED", f"shape {index} ({kind}) cannot be built: {error}",
                target=op["name"], detail={"constraints": [], "shape": index, "reason": str(error)},
                hints=["check that sizes are not zero and points differ"],
            ) from error
    return sketch


def check_sketch(ctx: Any, sketch: Any) -> list[dict[str, Any]]:
    """Solver diagnostics: raises on conflicts, returns warnings (under-constrained)."""
    path = sketch.Label
    try:
        sketch.solve()
    except Exception:
        pass
    names = lambda ids: [  # noqa: E731
        {"id": i, "name": (sketch.Constraints[i - 1].Name if 0 < i <= len(sketch.Constraints) else "")}
        for i in ids
    ]
    for attribute, code, word in (
        ("ConflictingConstraints", "SKETCH_CONFLICTING", "conflicting"),
        ("RedundantConstraints", "SKETCH_REDUNDANT", "redundant"),
        ("MalformedConstraints", "SKETCH_MALFORMED", "malformed"),
    ):
        ids = list(getattr(sketch, attribute, []) or [])
        if ids:
            raise ReifyOpError(
                code, f"sketch has {word} constraints",
                target=ctx.path_of(sketch), detail={"constraints": names(ids)},
                hints=["remove or change the dimension that fights another one"],
            )
    warnings: list[dict[str, Any]] = []
    dof = int(getattr(sketch, "DoF", 0) or 0)
    if dof > 0:
        warnings.append({"code": "SKETCH_UNDER_CONSTRAINED", "target": ctx.path_of(sketch), "detail": {"dof": dof}})
    del path
    return warnings
