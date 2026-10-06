"""Measurements and engineering checks on the in-memory shapes (imports FreeCAD).

Nothing here exports a STEP file: the shapes are already in the document.
"""

from __future__ import annotations

import math
import time
from typing import Any

import FreeCAD as App
import Part

from .core import bodies, get_path, is_body, is_sketch, owning_body, similar_paths
from .errors import ReifyOpError
from .roles import role_matches

DEFAULT_DENSITY_G_CM3 = 2.7


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _vec(v: Any) -> list[float]:
    return [_round(v.x), _round(v.y), _round(v.z)]


class Budget:
    """Cooperative time budget for long checks; the TS side also kills the worker."""

    def __init__(self, seconds: float | None) -> None:
        self.deadline = time.monotonic() + seconds if seconds else None

    def expired(self) -> bool:
        return self.deadline is not None and time.monotonic() > self.deadline

    def remaining(self) -> float | None:
        return None if self.deadline is None else self.deadline - time.monotonic()


# ---------------------------------------------------------------- target resolution

def shape_of(ctx: Any, target: str) -> Any:
    """Shape for a body, feature, or role path."""
    index = ctx.index()
    if target in index:
        obj = index[target]
        if is_body(obj) or hasattr(obj, "Shape"):
            if obj.Shape.isNull():
                raise ReifyOpError("TARGET_NOT_FOUND", f"'{target}' has no shape", target=target, detail={"target": target, "known": []})
            owner = owning_body(obj)
            if owner is None:
                return _one_solid(obj.Shape)
            placed = obj.Shape.copy()  # features live in their body's local frame
            placed.Placement = owner.Placement.multiply(placed.Placement)
            return _one_solid(placed)
    faces = _role_faces(ctx, target)
    if faces:
        return Part.makeCompound(faces)
    known = list(index)
    for body in bodies(ctx.doc):
        roles = ctx.session.roles(body)
        known.extend(roles.faces)
    raise ReifyOpError("TARGET_NOT_FOUND", f"nothing is named '{target}'", target=target,
                       detail={"target": target, "known": similar_paths(target, known)})


def _one_solid(shape: Any) -> Any:
    """FreeCAD sometimes wraps a body's single solid in a compound, which has no centre of mass."""
    if shape.ShapeType == "Compound" and len(shape.Solids) == 1:
        return shape.Solids[0]
    return shape


def _role_faces(ctx: Any, target: str) -> list[Any]:
    out: list[Any] = []
    for body in bodies(ctx.doc):
        roles = ctx.session.roles(body)
        for key, entries in roles.faces.items():
            if role_matches(key, target):
                out.extend(roles.to_world(entry.face) for entry in entries)
    return out


# ---------------------------------------------------------------- query

def centroid_of(shape: Any) -> Any:
    """Centre of mass; a compound of faces has none of its own, so weight each face by its area."""
    try:
        return shape.CenterOfMass
    except Exception:
        pass
    total = 0.0
    x = y = z = 0.0
    for face in shape.Faces:
        c, a = face.CenterOfMass, face.Area
        total += a
        x, y, z = x + c.x * a, y + c.y * a, z + c.z * a
    return App.Vector(x / total, y / total, z / total) if total else App.Vector()


def _quantity(value: Any) -> Any:
    return _round(value.Value) if hasattr(value, "Value") else value


def query(ctx: Any, target: str, what: list[str] | None) -> dict[str, Any]:
    index = ctx.index()
    wanted = what or ["params", "bbox"]
    result: dict[str, Any] = {"target": target}
    obj = index.get(target)
    if "params" in wanted and obj is not None:
        params: dict[str, Any] = {}
        expressions = {path: expr for path, expr in obj.ExpressionEngine} if hasattr(obj, "ExpressionEngine") else {}
        for name in obj.PropertiesList:
            if name in {"Length", "Length2", "Depth", "Diameter", "Radius", "Size", "Occurrences", "Angle", "Reversed", "Midplane", "Type", "HoleCutDiameter", "HoleCutDepth"} or (
                obj.getGroupOfProperty(name) == "Params"
            ):
                params[name] = _quantity(getattr(obj, name))
        if is_sketch(obj):
            params["constraints"] = {c.Name: _quantity(c.Value) for c in obj.Constraints if c.Name}
        result["params"] = params
        if expressions:
            result["expressions"] = {key: value for key, value in expressions.items()}
    if any(key in wanted for key in ("bbox", "volume", "area", "centroid", "faces")):
        shape = shape_of(ctx, target)
        if "bbox" in wanted:
            box = shape.BoundBox
            result["bbox"] = {"min": _vec(box.Min if hasattr(box, "Min") else App.Vector(box.XMin, box.YMin, box.ZMin)), "max": _vec(App.Vector(box.XMax, box.YMax, box.ZMax))}
        if "volume" in wanted:
            result["volumeMm3"] = _round(shape.Volume)
        if "area" in wanted:
            result["areaMm2"] = _round(shape.Area)
        if "centroid" in wanted:
            result["centroid"] = _vec(centroid_of(shape))
        if "faces" in wanted:
            result["faces"] = [_face_summary(face) for face in shape.Faces[:50]]
    unknown = [key for key in wanted if key not in {"params", "bbox", "volume", "area", "centroid", "faces"}]
    if unknown:
        raise ReifyOpError("OP_SCHEMA_INVALID", f"unknown query item(s) {unknown}", detail={"path": "what", "reason": "unknown item", "allowed": ["params", "bbox", "volume", "area", "centroid", "faces"]})
    return result


def _face_summary(face: Any) -> dict[str, Any]:
    surface = face.Surface
    out: dict[str, Any] = {"type": type(surface).__name__.lower(), "areaMm2": _round(face.Area), "center": _vec(face.CenterOfMass)}
    if isinstance(surface, Part.Plane):
        out["normal"] = _vec(surface.Axis)
    elif isinstance(surface, (Part.Cylinder, Part.Cone)):
        out["axis"] = _vec(surface.Axis)
        if isinstance(surface, Part.Cylinder):
            out["radius"] = _round(surface.Radius)
    return out


# ---------------------------------------------------------------- checks

def clearance(ctx: Any, a: str, b: str) -> dict[str, Any]:
    shape_a, shape_b = shape_of(ctx, a), shape_of(ctx, b)
    distance, pairs, _info = shape_a.distToShape(shape_b)
    pair = pairs[0] if pairs else None
    return {
        "kind": "clearance", "a": a, "b": b, "value": _round(distance, 6), "unit": "mm",
        **({"pointA": _vec(pair[0]), "pointB": _vec(pair[1])} if pair else {}),
    }


def interference(ctx: Any, pairs: list[list[str]] | None, all_pairs: bool, budget: Budget) -> dict[str, Any]:
    paths = {get_path(body): body for body in bodies(ctx.doc) if get_path(body)}
    combos: list[tuple[str, str]]
    if pairs:
        combos = [(p[0], p[1]) for p in pairs]
    elif all_pairs or True:
        names = sorted(paths)
        combos = [(names[i], names[j]) for i in range(len(names)) for j in range(i + 1, len(names))]
    results = []
    worst = 0.0
    for first, second in combos:
        if budget.expired():
            raise ReifyOpError("BUDGET_EXCEEDED", "interference check ran out of time", detail={"checked": len(results), "total": len(combos)})
        shape_a, shape_b = shape_of(ctx, first), shape_of(ctx, second)
        box_a, box_b = shape_a.BoundBox, shape_b.BoundBox
        if not box_a.intersect(box_b):
            results.append({"a": first, "b": second, "volumeMm3": 0.0, "skipped": "bounding boxes do not overlap"})
            continue
        common = shape_a.common(shape_b)
        volume = _round(common.Volume, 6) if not common.isNull() else 0.0
        worst = max(worst, volume)
        results.append({"a": first, "b": second, "volumeMm3": volume})
    return {"kind": "interference", "pairs": results, "value": worst, "unit": "mm3"}


def wall_thickness(ctx: Any, target: str, samples: int, budget: Budget) -> dict[str, Any]:
    """Minimum wall thickness by inward ray sampling on the target's faces."""
    shape = shape_of(ctx, target)
    solid_source = None
    index = ctx.index()
    obj = index.get(target)
    if obj is not None and hasattr(obj, "Shape") and obj.Shape.Solids:
        solid_source = obj.Shape
    if solid_source is None:
        for body in bodies(ctx.doc):
            if body.Shape.Solids and body.Shape.BoundBox.isInside(shape.BoundBox.Center):
                solid_source = body.Shape
                break
    if solid_source is None:
        raise ReifyOpError("TARGET_NOT_FOUND", f"'{target}' is not part of a solid", target=target, detail={"target": target, "known": []})
    faces = list(shape.Faces)
    per_face = max(1, samples // max(len(faces), 1))
    diagonal = solid_source.BoundBox.DiagonalLength
    best: tuple[float, Any, Any] | None = None
    taken = 0
    for face in faces:
        u0, u1, v0, v1 = face.ParameterRange
        grid = max(1, int(math.sqrt(per_face)))
        for i in range(grid):
            for j in range(grid):
                if budget.expired():
                    raise ReifyOpError("BUDGET_EXCEEDED", "wall thickness sampling ran out of time", detail={"sampled": taken, "requested": samples})
                u = u0 + (u1 - u0) * (i + 0.5) / grid
                v = v0 + (v1 - v0) * (j + 0.5) / grid
                if not face.isInside(face.valueAt(u, v), 1e-6, True):
                    continue
                point = face.valueAt(u, v)
                normal = face.normalAt(u, v)
                length = _inward_length(solid_source, point, normal, diagonal)
                taken += 1
                if length is not None and (best is None or length < best[0]):
                    best = (length, point, normal)
    if best is None:
        raise ReifyOpError("FEATURE_FAILED", "no wall samples could be measured", target=target, detail={"feature": target, "freecadStatus": "no inward ray hit the solid"})
    return {"kind": "wall_thickness", "target": target, "value": _round(best[0], 4), "unit": "mm", "at": _vec(best[1]), "samples": taken}


def _inward_length(solid: Any, point: Any, normal: Any, diagonal: float) -> float | None:
    start = point - normal * 1e-4
    ray = Part.makeLine(start, start - normal * diagonal)
    inside = solid.common(ray)
    if inside.isNull() or not inside.Edges:
        return None
    best = None
    for edge in inside.Edges:
        endpoints = [v.Point for v in edge.Vertexes]
        if endpoints and min((p - start).Length for p in endpoints) < 1e-3:
            best = edge.Length if best is None else max(best, edge.Length)
    return None if best is None else best + 1e-4


def _solids_of(shapes: list[Any]) -> list[Any]:
    solids: list[Any] = []
    for shape in shapes:
        solids.extend(shape.Solids)
    return solids


def mass(ctx: Any, target: str | None, density: float | None) -> dict[str, Any]:
    """Mass, centre of mass and inertia (about the centre of mass) of a body, feature, or every body."""
    paths = [target] if target else [get_path(b) for b in bodies(ctx.doc) if get_path(b)]
    solids = _solids_of([shape_of(ctx, p) for p in paths])
    if not solids:
        raise ReifyOpError("RESULT_NOT_SOLID", f"'{target or 'the document'}' has no solid to weigh", target=target,
                           detail={"body": target, "solids": 0, "validity": "empty"})
    rho = density if density is not None else ctx.session.density()
    scale = rho * 1e-3  # g/cm3 -> g/mm3
    volume = sum(solid.Volume for solid in solids)
    centre = App.Vector()
    for solid in solids:
        centre = centre + solid.CenterOfMass * (solid.Volume / volume)
    tensor = [[0.0] * 3 for _ in range(3)]
    for solid in solids:
        d = solid.CenterOfMass - centre
        m = solid.Volume
        inner = solid.MatrixOfInertia
        d2 = d.dot(d)
        components = (d.x, d.y, d.z)
        for i in range(3):
            for j in range(3):
                tensor[i][j] += getattr(inner, f"A{i + 1}{j + 1}") + m * ((d2 if i == j else 0.0) - components[i] * components[j])
    return {
        "kind": "mass", "target": target, "value": _round(volume * scale, 4), "unit": "g",
        "volumeMm3": _round(volume), "densityGPerCm3": rho,
        "centerOfMassMm": _vec(centre),
        "inertiaGMm2": [[_round(value * scale, 3) for value in row] for row in tensor],
    }


def run_check(ctx: Any, kind: str, args: dict[str, Any], budget: Budget) -> dict[str, Any]:
    if kind == "clearance":
        return clearance(ctx, _need(args, "a"), _need(args, "b"))
    if kind == "interference":
        return interference(ctx, args.get("pairs"), bool(args.get("all", False)), budget)
    if kind == "wall_thickness":
        return wall_thickness(ctx, _need(args, "target"), int(args.get("samples", 200)), budget)
    if kind == "mass":
        return mass(ctx, args.get("target"), args.get("density"))
    raise ReifyOpError("OP_SCHEMA_INVALID", f"unknown check kind {kind!r}", detail={"path": "kind", "reason": "unknown", "allowed": ["clearance", "interference", "wall_thickness", "mass"]})


def _need(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value:
        raise ReifyOpError("OP_SCHEMA_INVALID", f"check needs '{key}'", detail={"path": key, "reason": "required"})
    return value
