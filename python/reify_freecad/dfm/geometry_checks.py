"""Second-layer (geometry) check functions, keyed by ``Rule.check`` (imports FreeCAD).

Each function takes the geometry facts built by ``geometry.build_facts``, its ``Rule`` and the
``Rulepack`` and returns a list of issues. Thresholds come from ``rule.params`` or the rulepack
tables. Where the rulepack has no threshold, a named constant below is used and the issue
message says "(inferred threshold)". Shape analysis is built in (OCCT, via FreeCAD). When
reify-asi ran, its hole list and per-face thickness replace the built-in ones.

Targets: a feature path (``"part/m3_tap"``) when the face belongs to a named feature, else
``{"body", "face", "centre"}``. Whole-part rules use the body path.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any, Callable

import FreeCAD as App
import Part

from ..core import path_index
from .issues import make_issue
from .rulepack import Rule, Rulepack

#: Slender suspended wall: height or length over thickness above which the wall is "slender".
#: Not in the PDF; inferred. The issue message says so.
SLENDER_ASPECT_INFERRED = 8.0
#: Ganging: a neck whose section is below this share of the largest section, with both sides
#: holding more than GANG_SIDE_SHARE of the volume. Not in the PDF; inferred.
GANG_NECK_SHARE_INFERRED = 0.05
GANG_SIDE_SHARE_INFERRED = 0.20
GANG_SAMPLES = 40
THICKNESS_SAMPLES_PER_FACE = 4
PROBE_OFFSET_MM = 0.01
NORMAL_EPS = 1e-3
EPS = 1e-6

#: Rules whose geometry needs reify-asi data; without the analyzer they are reported as skipped.
NEEDS_ASI = frozenset({"surface_multi_face"})

GeometryCheck = Callable[[dict[str, Any], Rule, Rulepack], list[dict[str, Any]]]


class BudgetExceeded(Exception):
    """The run's time budget ran out inside a check."""


@dataclass
class FaceInfo:
    idx: int
    face: Any
    kind: str
    centre: Any
    normal: Any
    area: float
    bbox: Any
    zmin: float
    zmax: float
    feature: str | None = None
    role: str | None = None
    concave: bool = False
    axis: Any = None
    origin: Any = None
    radius: float | None = None
    vrange: tuple[float, float] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class BodyFaces:
    path: str
    kind: str
    local: Any
    world: Any
    faces: list[FaceInfo]
    by_index: dict[int, FaceInfo]
    bbox: Any

    def lookup(self, shape_face: Any) -> FaceInfo | None:
        for info in self.faces:
            if info.face.isSame(shape_face):
                return info
        return None


# ---------------------------------------------------------------- helpers

def _issue(rule: Rule, pack: Rulepack, target: Any, **kwargs: Any) -> dict[str, Any]:
    return make_issue(rule, layer="geometry", target=target, rulepack=pack, **kwargs)


def _skip(facts: dict[str, Any], reason: str) -> None:
    facts.setdefault("_skipped", []).append(reason)


def _tick(facts: dict[str, Any]) -> None:
    if facts["budget"].expired():
        raise BudgetExceeded()


def _r(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def _pt(vector: Any) -> list[float]:
    return [_r(vector.x, 4), _r(vector.y, 4), _r(vector.z, 4)]


def _line_distance(origin: Any, axis: Any, point: Any) -> float:
    rel = point - origin
    return (rel - axis * rel.dot(axis)).Length


def _perp_basis(axis: Any) -> tuple[Any, Any]:
    helper = App.Vector(1, 0, 0) if abs(axis.x) < 0.9 else App.Vector(0, 1, 0)
    u = axis.cross(helper)
    u.normalize()
    v = axis.cross(u)
    v.normalize()
    return u, v


def _target(body: BodyFaces, face: FaceInfo) -> Any:
    return face.feature if face.feature else {"body": body.path, "face": face.idx, "centre": _pt(face.centre)}


def _hole_target(hole: dict[str, Any]) -> Any:
    for face in hole["faces"]:
        if face.feature:
            return face.feature
    return _target(hole["body"], hole["faces"][0])


def _is_plane(face: FaceInfo) -> bool:
    return face.kind == "Plane"


def _is_horizontal_face(face: FaceInfo) -> bool:
    """A planar face normal to Z (top or bottom)."""
    return _is_plane(face) and abs(face.normal.z) > 1 - EPS


def _is_vertical_wall(face: FaceInfo) -> bool:
    """A planar face whose normal is horizontal."""
    return _is_plane(face) and abs(face.normal.z) < NORMAL_EPS


def _is_vertical_cylinder(face: FaceInfo) -> bool:
    return face.kind == "Cylinder" and face.axis is not None and abs(face.axis.z) > 1 - EPS


def _on_envelope(face: FaceInfo, body: BodyFaces) -> bool:
    """A planar face lying on the bounding box of its body (an outer face)."""
    box, fb = body.bbox, face.bbox
    tol = 1e-4
    for low, high, flo, fhi in (
        (box.XMin, box.XMax, fb.XMin, fb.XMax), (box.YMin, box.YMax, fb.YMin, fb.YMax), (box.ZMin, box.ZMax, fb.ZMin, fb.ZMax),
    ):
        if abs(fhi - flo) < tol and (abs(flo - low) < tol or abs(flo - high) < tol):
            return True
    return False


def _touches_envelope(face: FaceInfo, body: BodyFaces) -> bool:
    box, fb = body.bbox, face.bbox
    tol = 1e-4
    return (abs(fb.XMin - box.XMin) < tol or abs(fb.XMax - box.XMax) < tol
            or abs(fb.YMin - box.YMin) < tol or abs(fb.YMax - box.YMax) < tol)


def _segments(shape: Any, start: Any, direction: Any, length: float) -> list[tuple[float, float]]:
    """Material intervals along a ray, as distances from ``start`` (sorted, merged)."""
    line = Part.makeLine(start, start + direction * length)
    common = shape.common(line)
    if common.isNull():
        return []
    spans = []
    for edge in common.Edges:
        params = [(vertex.Point - start).dot(direction) for vertex in edge.Vertexes]
        if len(params) >= 2:
            spans.append((min(params), max(params)))
    spans.sort()
    merged: list[list[float]] = []
    for low, high in spans:
        if merged and low <= merged[-1][1] + 1e-6:
            merged[-1][1] = max(merged[-1][1], high)
        else:
            merged.append([low, high])
    return [(low, high) for low, high in merged]


def _material_run(shape: Any, start: Any, direction: Any, length: float) -> float | None:
    """Length of the material run that starts at ``start`` (a point inside the material)."""
    for low, high in _segments(shape, start, direction, length):
        if low <= 1e-3:
            return high
    return None


def _edge_convex(edge: Any, centre_a: Any, normal_a: Any, centre_b: Any, normal_b: Any) -> bool | None:
    """True when the solid is convex at the edge between two planes (None when undecidable)."""
    first, last = edge.FirstParameter, edge.LastParameter
    middle = (first + last) / 2
    mid = edge.valueAt(middle)
    tangent = edge.tangentAt(middle)
    if tangent.Length < 1e-12:
        return None
    tangent.normalize()
    da = centre_a - mid
    da = da - tangent * da.dot(tangent)
    db = centre_b - mid
    db = db - tangent * db.dot(tangent)
    if da.Length < 1e-9 or db.Length < 1e-9:
        return None
    da.normalize()
    db.normalize()
    return db.dot(normal_a) < -1e-6 and da.dot(normal_b) < -1e-6


def _adjacent(body: BodyFaces, edge: Any, exclude: int | None = None) -> list[FaceInfo]:
    out: list[FaceInfo] = []
    for shape_face in body.world.ancestorsOfType(edge, Part.Face):
        info = body.lookup(shape_face)
        if info is not None and info.idx != exclude:
            out.append(info)
    return out


def face_info(index: int, face: Any) -> FaceInfo:
    kind = type(face.Surface).__name__
    u0, u1, v0, v1 = face.ParameterRange
    um, vm = (u0 + u1) / 2, (v0 + v1) / 2
    centre = face.CenterOfMass
    if not face.isInside(centre, 1e-6, True):
        centre = face.valueAt(um, vm)
    try:
        normal = face.normalAt(um, vm)
    except Exception:  # noqa: BLE001 - a degenerate parameter (a pole) has no normal; the centre is good enough
        normal = App.Vector(0, 0, 1)
    box = face.BoundBox
    info = FaceInfo(
        idx=index, face=face, kind=kind, centre=centre, normal=normal, area=face.Area, bbox=box,
        zmin=box.ZMin, zmax=box.ZMax,
    )
    if kind == "Cylinder":
        surface = face.Surface
        info.axis = surface.Axis.normalize() if surface.Axis.Length else App.Vector(0, 0, 1)
        info.origin = surface.Center
        info.radius = float(surface.Radius)
        info.vrange = (float(v0), float(v1))
        info.extra["span"] = float(u1 - u0)
        radial = (centre - info.origin) - info.axis * (centre - info.origin).dot(info.axis)
        info.concave = normal.dot(radial) < 0
    elif kind == "Cone":
        surface = face.Surface
        info.axis = surface.Axis.normalize()
        info.origin = surface.Apex
    elif kind == "Torus":
        info.extra["minor"] = float(face.Surface.MinorRadius)
    return info


# ---------------------------------------------------------------- shared derived data (cached in facts)

def _cache(facts: dict[str, Any], key: Any, build: Callable[[], Any]) -> Any:
    store = facts["cache"]
    if key not in store:
        _tick(facts)
        store[key] = build()
    return store[key]


def _feature_objects(facts: dict[str, Any]) -> dict[str, Any]:
    return _cache(facts, "feature_objects", lambda: path_index(facts["session"].doc))


def _feature_type(facts: dict[str, Any], path: str | None) -> str | None:
    if not path:
        return None
    obj = _feature_objects(facts).get(path)
    return obj.TypeId if obj is not None else None


def _feature_groups(facts: dict[str, Any], body: BodyFaces) -> dict[str, list[FaceInfo]]:
    def build() -> dict[str, list[FaceInfo]]:
        groups: dict[str, list[FaceInfo]] = {}
        for face in body.faces:
            if face.feature:
                groups.setdefault(face.feature, []).append(face)
        return groups

    return _cache(facts, ("feature_groups", body.path), build)


def _pocket_groups(facts: dict[str, Any]) -> list[tuple[BodyFaces, str, list[FaceInfo]]]:
    out = []
    for body in facts["bodies"]:
        for path, faces in _feature_groups(facts, body).items():
            if _feature_type(facts, path) == "PartDesign::Pocket":
                out.append((body, path, faces))
    return out


def _thickness(facts: dict[str, Any], body: BodyFaces) -> dict[int, tuple[float, Any]]:
    """Face index -> (thickness, point): reify-asi when it ran, else inward ray casts."""
    def build() -> dict[int, tuple[float, Any]]:
        asi = (facts["asi"] or {}).get(body.path)
        if asi is not None:
            return {int(item["face"]): (float(item["min"]), item.get("at")) for item in asi.get("thickness", [])}
        diagonal = body.world.BoundBox.DiagonalLength
        out: dict[int, tuple[float, Any]] = {}
        for face in body.faces:
            _tick(facts)
            best = None
            u0, u1, v0, v1 = face.face.ParameterRange
            grid = max(1, int(math.sqrt(THICKNESS_SAMPLES_PER_FACE)))
            for i in range(grid):
                for j in range(grid):
                    u = u0 + (u1 - u0) * (i + 0.5) / grid
                    v = v0 + (v1 - v0) * (j + 0.5) / grid
                    point = face.face.valueAt(u, v)
                    if not face.face.isInside(point, 1e-6, True):
                        continue
                    normal = face.face.normalAt(u, v)
                    run = _material_run(body.world, point - normal * 1e-4, -normal, diagonal)
                    if run is None:
                        continue
                    value = run + 1e-4
                    if best is None or value < best[0]:
                        best = (value, point)
            if best is not None:
                out[face.idx] = best
        return out

    return _cache(facts, ("thickness", body.path), build)


def _cylinder_groups(body: BodyFaces) -> list[list[FaceInfo]]:
    """Concave cylinder faces (hole walls) grouped into one hole per axis line and radius.

    A hole is a whole circle: a group must cover 360 degrees. The round end of a pocket (a slot)
    is a concave arc of 180 degrees and is not a hole.
    """
    groups: list[tuple[Any, Any, float, list[FaceInfo]]] = []
    for face in body.faces:
        if face.kind != "Cylinder" or not face.concave:
            continue
        for axis, origin, radius, members in groups:
            if (abs(abs(axis.dot(face.axis)) - 1) < 1e-7 and abs(radius - face.radius) < 1e-5
                    and _line_distance(origin, axis, face.origin) < 1e-4):
                members.append(face)
                break
        else:
            groups.append((face.axis, face.origin, face.radius, [face]))
    return [members for _axis, _origin, _radius, members in groups if sum(f.extra["span"] for f in members) > 2 * math.pi - 1e-3]


def _hole_from_faces(facts: dict[str, Any], body: BodyFaces, faces: list[FaceInfo], hint: dict[str, Any] | None) -> dict[str, Any] | None:
    axis = faces[0].axis
    origin = faces[0].origin
    radius = faces[0].radius
    spans = []
    for face in faces:
        sign = 1.0 if face.axis.dot(axis) > 0 else -1.0
        offset = (face.origin - origin).dot(axis)
        v0, v1 = face.vrange
        a, b = offset + sign * v0, offset + sign * v1
        spans.extend([min(a, b), max(a, b)])
    t0, t1 = min(spans), max(spans)
    if t1 - t0 < 1e-6:
        return None
    m0 = _material_beyond(facts, body, origin, axis, t0, -1.0, radius)
    m1 = _material_beyond(facts, body, origin, axis, t1, 1.0, radius)
    hole = {
        "body": body, "faces": faces, "origin": origin, "axis": axis, "radius": radius,
        "diameter": 2 * radius, "t0": t0, "t1": t1, "depth": t1 - t0,
    }
    # A countersink or chamfer at the open end also has material just outside the ring, so an end
    # that opens outward is never the bottom, whatever the ring probe says.
    if m0 and m1:
        if _opens_at_end(hole, low=True):
            m0 = False
        elif _opens_at_end(hole, low=False):
            m1 = False
    # reify-asi's through / bottom flags are not used: its on-axis probe reads a drill-point cone
    # as open (deep_hole fixture), so the ring probes above and the adjacent face decide.
    through = not m0 and not m1
    bottom_t: float | None = None
    if not through:
        if m0 and not m1:
            bottom_t = t0
        elif m1 and not m0:
            bottom_t = t1
    hole.update({"through": through, "bottom": "none" if through else "unknown", "bottom_t": bottom_t})
    hole["target"] = _hole_target(hole)
    if not through and bottom_t is not None:
        hole["bottom"] = _bottom_shape(hole, low=bottom_t == t0)
    return hole


def _material_beyond(facts: dict[str, Any], body: BodyFaces, origin: Any, axis: Any, t_end: float, sign: float, radius: float) -> bool:
    """True when material lies just beyond a hole end (a blind bottom), probed on a ring around the hole."""
    base = origin + axis * (t_end + sign * PROBE_OFFSET_MM)
    u, v = _perp_basis(axis)
    for k in range(8):
        angle = 2 * math.pi * k / 8
        direction = u * math.cos(angle) + v * math.sin(angle)
        if body.world.isInside(base + direction * (1.5 * radius), EPS, True):
            return True
    return False


def _bottom_shape(hole: dict[str, Any], low: bool) -> str:
    """Shape of the blind bottom at one end: the kind of the face the hole's end meets."""
    for other in _end_faces(hole, low):
        if other.kind == "Plane":
            return "flat"
        if other.kind == "Cone":
            return "cone"
        if other.kind == "Sphere":
            return "sphere"
    return "unknown"


def _opens_at_end(hole: dict[str, Any], low: bool) -> bool:
    """True when a cone meeting this end widens beyond the hole radius (a countersink or chamfer)."""
    limit = hole["radius"] * (1 + 1e-3)
    for other in _end_faces(hole, low):
        if other.kind != "Cone":
            continue
        for edge in other.face.Edges:
            if type(edge.Curve).__name__ == "Circle" and edge.Curve.Radius > limit:
                return True
    return False


def _holes(facts: dict[str, Any]) -> list[dict[str, Any]]:
    def build() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for body in facts["bodies"]:
            asi = (facts["asi"] or {}).get(body.path)
            if asi is not None:
                pieces = []
                for entry in asi.get("holes", []):
                    faces = [body.by_index[i] for i in entry.get("faces", []) if i in body.by_index and body.by_index[i].kind == "Cylinder"]
                    if faces:
                        pieces.append((faces, entry))
            else:
                pieces = [(members, None) for members in _cylinder_groups(body)]
            for faces, hint in pieces:
                _tick(facts)
                hole = _hole_from_faces(facts, body, faces, hint)
                if hole is not None:
                    out.append(hole)
        return out

    return _cache(facts, "holes", build)


def _hole_thread(facts: dict[str, Any], hole: dict[str, Any]) -> tuple[bool, bool, str | None]:
    """(threaded, modelled thread, thread size) from the hole feature; geometry cannot tell a thread."""
    target = hole["target"]
    obj = _feature_objects(facts).get(target) if isinstance(target, str) else None
    if obj is None or obj.TypeId != "PartDesign::Hole" or not bool(obj.Threaded):
        return False, False, None
    size = str(obj.ThreadSize).partition("x")[0]
    return True, bool(obj.ModelThread), size


def _cones(facts: dict[str, Any], body: BodyFaces) -> list[dict[str, Any]]:
    """Each cone face with its two end circles, the radius of each and the faces next to it."""
    def build() -> list[dict[str, Any]]:
        out = []
        for face in body.faces:
            if face.kind != "Cone":
                continue
            ends = []
            for edge in face.face.Edges:
                if type(edge.Curve).__name__ != "Circle":
                    continue
                neighbours = _adjacent(body, edge, exclude=face.idx)
                ends.append({"radius": float(edge.Curve.Radius), "kinds": {n.kind for n in neighbours}, "faces": neighbours})
            ends.sort(key=lambda end: -end["radius"])
            out.append({"face": face, "ends": ends})
        return out

    return _cache(facts, ("cones", body.path), build)


def _countersinks(facts: dict[str, Any], body: BodyFaces) -> list[dict[str, Any]]:
    """Countersinks: a cone whose wide end sits on a planar face of the body (not on a bore)."""
    out = []
    for cone in _cones(facts, body):
        if len(cone["ends"]) != 2:
            continue
        wide, narrow = cone["ends"]
        if "Plane" in wide["kinds"] and "Cylinder" not in wide["kinds"]:
            out.append({"face": cone["face"], "narrow": narrow})
    return out


def _mated_paths(facts: dict[str, Any]) -> set[str]:
    def build() -> set[str]:
        group = facts["session"].requirements_group(create=False)
        mated: set[str] = set()
        for item in (group.Group if group is not None else []):
            try:
                target = json.loads(item.Target)
            except (ValueError, AttributeError):
                continue
            if not isinstance(target, dict):
                continue
            if item.Kind == "min_clearance":
                mated.update(str(target.get(key, "")) for key in ("a", "b"))
            elif item.Kind == "dimension":
                mated.add(str(target.get("target", "")))
        return {m for m in mated if m}

    return _cache(facts, "mated", build)


def _cavity_width(facts: dict[str, Any], body: BodyFaces, faces: list[FaceInfo]) -> tuple[float | None, bool]:
    """Narrowest distance across a pocket between two of its vertical walls, and whether a wall opens outside."""
    diagonal = body.world.BoundBox.DiagonalLength
    depth = _depth_axis(facts, faces)
    best: float | None = None
    opens = False
    for wall in faces:
        if not _is_vertical_wall(wall):
            continue
        if depth is not None and abs(wall.normal.dot(depth)) > 1 - EPS:
            continue  # a floor, not a wall: its distance is the depth
        _tick(facts)
        start = wall.centre + wall.normal * 1e-4
        spans = _segments(body.world, start, wall.normal, diagonal)
        if not spans:
            # the wall opens outward: its width runs to the part's bounding box edge
            opens = True
            distance = _bbox_exit(body.world.BoundBox, start, wall.normal)
            if distance is not None and (best is None or distance < best):
                best = distance
            continue
        distance = spans[0][0]
        if best is None or distance < best:
            best = distance
    return (_r(best, 4) if best is not None else None), opens


def _depth_axis(facts: dict[str, Any], faces: list[FaceInfo]) -> Any:
    """The cutting direction of a pocket: the normal of its sketch plane (None when unknown)."""
    feature = faces[0].feature if faces else None
    obj = _feature_objects(facts).get(feature) if feature else None
    if obj is None or "Profile" not in obj.PropertiesList:
        return None
    profile = obj.Profile
    sketch = profile[0] if isinstance(profile, (tuple, list)) else profile
    if sketch is None:
        return None
    return sketch.Placement.Rotation.multVec(App.Vector(0, 0, 1))


def _bbox_exit(box: Any, start: Any, direction: Any) -> float | None:
    """Distance from start along direction to the bounding box boundary (None when not inside it)."""
    best: float | None = None
    for axis in ("x", "y", "z"):
        d = getattr(direction, axis)
        if abs(d) < 1e-9:
            continue
        p = getattr(start, axis)
        limit = getattr(box, f"{axis.upper()}Max") if d > 0 else getattr(box, f"{axis.upper()}Min")
        t = (limit - p) / d
        if t > EPS and (best is None or t < best):
            best = t
    return best


def _pocket_depth(faces: list[FaceInfo]) -> float:
    walls = [f for f in faces if abs(f.normal.z) < 0.5]
    if not walls:
        return 0.0
    return max(f.zmax for f in walls) - min(f.zmin for f in walls)


def _tool_below(pack: Rulepack, width: float) -> float | None:
    smaller = [t for t in pack.tables["tool_diameters_mm"] if t < width - EPS]
    return max(smaller) if smaller else None


# ---------------------------------------------------------------- 5.1 stock

def stock_side_height(facts, rule, pack):
    limit = rule.params["max_mm"]
    issues = []
    for body in facts["bodies"]:
        if body.bbox.ZLength <= limit:
            continue
        seen: set[Any] = set()
        for face in body.faces:
            if abs(face.normal.z) >= 0.2 or _on_envelope(face, body):
                continue
            if face.kind == "Cylinder" and face.concave:
                continue  # a round hole on the side is allowed
            target = _target(body, face)
            key = json_key(target)
            if key in seen:
                continue
            seen.add(key)
            issues.append(_issue(rule, pack, target, measured=_r(body.bbox.ZLength), limit=limit,
                                 message=f"side height {_r(body.bbox.ZLength)} mm is over {limit:g} mm; only round holes are allowed on the sides"))
    return issues


def json_key(target: Any) -> str:
    return repr(sorted(target.items())) if isinstance(target, dict) else str(target)


def _cut_features(facts: dict[str, Any], body: BodyFaces) -> dict[str, list[FaceInfo]]:
    """Pocket features (cut features with a profile) with their faces. Holes and pads are not cuts for the back-side rules."""
    return {
        feature: faces for feature, faces in _feature_groups(facts, body).items()
        if _feature_type(facts, feature) == "PartDesign::Pocket"
    }


def _opening_side(facts: dict[str, Any], body: BodyFaces, feature: str) -> str | None:
    """"top" or "bottom": the face of the body a pocket is cut from, by the height of its sketch plane."""
    obj = _feature_objects(facts).get(feature)
    if obj is None or "Profile" not in obj.PropertiesList:
        return None
    profile = obj.Profile
    sketch = profile[0] if isinstance(profile, (tuple, list)) else profile
    if sketch is None:
        return None
    z = sketch.Placement.Base.z
    return "top" if abs(z - body.bbox.ZMax) <= abs(z - body.bbox.ZMin) else "bottom"


def _cut_sides(facts: dict[str, Any], body: BodyFaces) -> tuple[bool, bool]:
    """(pockets cut from the top, pockets cut from the bottom) of one body."""
    sides = {_opening_side(facts, body, feature) for feature in _cut_features(facts, body)}
    return "top" in sides, "bottom" in sides


def stock_standard_thickness(facts, rule, pack):
    dz = facts["bbox"][2]
    standard = rule.params["standard_mm"]
    if any(abs(dz - value) <= 1e-3 for value in standard):
        return []
    message = f"Z thickness {_r(dz)} mm is not a common standard plate thickness"
    if any(all(_cut_sides(facts, b)) for b in facts["bodies"]):
        message += "; the double-sided features on this part add machining risk"
    return [_issue(rule, pack, facts["part"], measured=_r(dz), message=message)]


def stock_thin_plate_large(facts, rule, pack):
    dx, dy, dz = facts["bbox"]
    params = rule.params
    longest = max(dx, dy)
    if longest <= params["large_longest_mm"]:
        return []
    standard = pack.tables["standard_thickness_mm"]
    issues = []
    if dz < params["thin_mm"] and not any(abs(dz - v) <= 1e-3 for v in standard):
        issues.append(_issue(rule, pack, facts["part"], measured=_r(dz), limit=params["thin_mm"],
                             message=f"large thin plate ({_r(dz)} mm thick, longest side {_r(longest)} mm) must use a standard thickness"))
    if dz < params["very_thin_mm"]:
        footprint = dx * dy
        recessed = 0.0
        for body in facts["bodies"]:
            recessed += sum(f.area for f in body.faces if _is_horizontal_face(f) and f.zmin > body.bbox.ZMin + 1e-3 and f.zmax < body.bbox.ZMax - 1e-3)
        if footprint > 0 and recessed > 0.5 * footprint:
            issues.append(_issue(rule, pack, facts["part"], measured=_r(dz), limit=params["very_thin_mm"],
                                 message=f"thickness {_r(dz)} mm is under {params['very_thin_mm']:g} mm and over half the footprint is cut away (planar removal)"))
    return issues


# ---------------------------------------------------------------- 5.2 holes

def hole_min_diameter(facts, rule, pack):
    limit = rule.params["min_mm"]
    return [_issue(rule, pack, _hole_target(h), measured=_r(h["diameter"]), limit=limit)
            for h in _holes(facts) if h["diameter"] < limit - EPS]


def hole_depth_ratio(facts, rule, pack):
    params = rule.params
    issues = []
    for hole in _holes(facts):
        if hole["diameter"] <= 0:
            continue
        ratio = hole["depth"] / hole["diameter"]
        for level, threshold in (("error", params["error_ratio"]), ("warn", params["warn_ratio"]), ("info", params["info_ratio"])):
            if ratio > threshold + EPS:
                issues.append(_issue(rule, pack, _hole_target(hole), measured=_r(ratio), limit=threshold, unit="ratio", severity=level,
                                     message=f"depth/diameter {ratio:.2f} is over {threshold:g}"))
                break
    return issues


def hole_thread_tap_drill(facts, rule, pack):
    table = pack.tables["tap_drill_mm"]
    tolerance = rule.params["tolerance_mm"]
    issues = []
    for hole in _holes(facts):
        threaded, modelled, size = _hole_thread(facts, hole)
        if not threaded or modelled or size not in table:
            continue
        expected = table[size]
        if abs(hole["diameter"] - expected) > tolerance + EPS:
            issues.append(_issue(rule, pack, _hole_target(hole), measured=_r(hole["diameter"]), limit=expected,
                                 message=f"{size} tapped hole should be φ{expected:g} (tap drill table), is φ{_r(hole['diameter'])}",
                                 hints=[f"set diameter {expected:g}"]))
    return issues


def hole_thread_side_wall(facts, rule, pack):
    margin_min = rule.params["min_margin_mm"]
    issues = []
    for hole in _holes(facts):
        threaded, _modelled, _size = _hole_thread(facts, hole)
        if not threaded or abs(hole["axis"].z) < 0.9:
            continue
        body = hole["body"]
        mid = hole["origin"] + hole["axis"] * ((hole["t0"] + hole["t1"]) / 2)
        box = body.bbox
        distance = min(mid.x - box.XMin, box.XMax - mid.x, mid.y - box.YMin, box.YMax - mid.y)
        margin = distance - hole["radius"]
        if margin < margin_min - EPS:
            issues.append(_issue(rule, pack, _hole_target(hole), measured=_r(margin), limit=margin_min,
                                 message=f"thread hole is {_r(margin)} mm from the outer wall; at least {margin_min:g} mm is needed"))
    return issues


def hole_blind_bottom_wall(facts, rule, pack):
    params = rule.params
    issues = []
    diagonal_cache: dict[str, float] = {}
    for hole in _holes(facts):
        if hole["through"] or hole["bottom_t"] is None:
            continue
        direction = hole["axis"] if hole["bottom_t"] == hole["t1"] else hole["axis"] * -1
        bottom = hole["origin"] + hole["axis"] * hole["bottom_t"]
        body = hole["body"]
        diagonal = diagonal_cache.setdefault(body.path, body.world.BoundBox.DiagonalLength)
        run = _material_run(body.world, bottom + direction * 1e-4, direction, diagonal)
        if run is None:
            continue
        wall = run + 1e-4
        required = max(params["min_ratio"] * hole["diameter"], params["min_mm"])
        if wall < required - EPS:
            issues.append(_issue(rule, pack, _hole_target(hole), measured=_r(wall), limit=_r(required),
                                 message=f"wall under the blind bottom is {_r(wall)} mm; at least {_r(required)} mm is needed"))
    return issues


def hole_bottom_shape(facts, rule, pack):
    cone_severity = rule.params.get("cone_severity", "info")
    issues = []
    for hole in _holes(facts):
        if hole["through"]:
            continue
        shape = hole["bottom"]
        if shape == "sphere":
            issues.append(_issue(rule, pack, _hole_target(hole), message="blind hole bottom is spherical or arc-shaped; use a flat bottom"))
        elif shape == "cone":
            issues.append(_issue(rule, pack, _hole_target(hole), severity=cone_severity,
                                 message="blind hole with a drill-point cone bottom; a flat bottom is recommended"))
    return issues


def hole_internal_chamfer(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        for cone in _cones(facts, body):
            if len(cone["ends"]) == 2 and all("Cylinder" in end["kinds"] for end in cone["ends"]):
                issues.append(_issue(rule, pack, _target(body, cone["face"]), message="a chamfer between two bores of a stepped hole is not supported"))
    return issues


def hole_ring_groove(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        walls = [f for f in body.faces if f.kind == "Cylinder" and f.concave]
        lines: list[tuple[Any, Any, list[FaceInfo]]] = []
        for face in walls:
            for axis, origin, members in lines:
                if abs(abs(axis.dot(face.axis)) - 1) < 1e-7 and _line_distance(origin, axis, face.origin) < 1e-4:
                    members.append(face)
                    break
            else:
                lines.append((face.axis, face.origin, [face]))
        for axis, origin, members in lines:
            runs = []
            for face in sorted(members, key=lambda f: (f.origin - origin).dot(axis) + f.vrange[0] * f.axis.dot(axis)):
                if runs and abs(runs[-1]["radius"] - face.radius) < 1e-5:
                    runs[-1]["faces"].append(face)
                else:
                    runs.append({"radius": face.radius, "faces": [face]})
            for before, middle, after in zip(runs, runs[1:], runs[2:]):
                if middle["radius"] > before["radius"] + 1e-3 and middle["radius"] > after["radius"] + 1e-3:
                    issues.append(_issue(rule, pack, _target(body, middle["faces"][0]),
                                         message="a ring groove or T slot inside a hole is not supported"))
    return issues


def hole_countersink(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        for sink in _countersinks(facts, body):
            issues.append(_issue(rule, pack, _target(body, sink["face"]), message="countersink may fail or be incomplete; use a counterbore"))
    return issues


def hole_countersink_to_bottom(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        for sink in _countersinks(facts, body):
            if "Cylinder" not in sink["narrow"]["kinds"]:
                issues.append(_issue(rule, pack, _target(body, sink["face"]),
                                     message="the countersink cone reaches the bottom; keep a cylindrical bottom hole"))
    return issues


def hole_side_support_face(facts, rule, pack):
    issues = []
    for hole in _holes(facts):
        if abs(hole["axis"].z) > 0.1:
            continue
        if hole["through"]:
            ends = [True, False]
        elif hole["bottom_t"] is not None:
            ends = [hole["bottom_t"] == hole["t0"]]
        else:
            ends = []
        bad = False
        for low in ends:
            for face in _end_faces(hole, low):
                if not (face.kind == "Plane" and abs(face.normal.dot(hole["axis"])) > 1 - 1e-4):
                    bad = True
        if bad:
            issues.append(_issue(rule, pack, _hole_target(hole),
                                 message="the side hole has no flat support face on the far side (a curved or inclined face is there)"))
    return issues


def _end_faces(hole: dict[str, Any], low: bool) -> list[FaceInfo]:
    """Faces (not the hole's own walls) that the hole's end edges meet, at the low or the high axial end.

    An edge belongs to one end when all its vertices lie on that side of the hole's middle; seam
    edges span both ends and are skipped. A curved exit has no circle, so edges are used, not circles.
    """
    body = hole["body"]
    origin, axis = hole["origin"], hole["axis"]
    middle = (hole["t0"] + hole["t1"]) / 2
    own = {f.idx for f in hole["faces"]}
    found: dict[int, FaceInfo] = {}
    for face in hole["faces"]:
        for edge in face.face.Edges:
            positions = [(vertex.Point - origin).dot(axis) for vertex in edge.Vertexes]
            if not positions:
                continue
            if low and all(p < middle for p in positions) or (not low) and all(p > middle for p in positions):
                for other in _adjacent(body, edge):
                    if other.idx not in own:
                        found[other.idx] = other
    return list(found.values())


# ---------------------------------------------------------------- 5.3 cavities and corners

def hole_waist_slot_depth(facts, rule, pack):
    params = rule.params
    issues = []
    for body, path, faces in _pocket_groups(facts):
        if not any(_is_vertical_cylinder(f) for f in faces):
            continue  # a waist slot has round ends
        width, _opens = _cavity_width(facts, body, faces)
        if width is None:
            continue
        depth = _pocket_depth(faces)
        limit = params["max_depth_ratio"] * width
        if depth > limit + EPS:
            footprint = max(max(f.bbox.XLength, f.bbox.YLength) for f in faces)
            relaxed = footprint / width > params["relaxed_aspect_ratio"] + EPS
            issues.append(_issue(rule, pack, path, measured=_r(depth), limit=_r(limit), unit="mm",
                                 severity=params["relaxed_severity"] if relaxed else None,
                                 message=f"waist slot is {_r(depth)} mm deep, over {params['max_depth_ratio']:g} x its {_r(width)} mm width"))
    return issues


def cavity_min_width(facts, rule, pack):
    limit = rule.params["min_mm"]
    issues = []
    for body, path, faces in _pocket_groups(facts):
        width, _opens = _cavity_width(facts, body, faces)
        if width is not None and width < limit - EPS:
            issues.append(_issue(rule, pack, path, measured=_r(width), limit=limit))
    return issues


def cavity_depth_tool_ratio(facts, rule, pack):
    issues = []
    for body, path, faces in _pocket_groups(facts):
        width, _opens = _cavity_width(facts, body, faces)
        if width is None:
            continue
        tool = _tool_below(pack, width)
        if tool is None:
            continue
        limit = rule.params["max_ratio"] * tool
        depth = _pocket_depth(faces)
        if depth > limit + EPS:
            issues.append(_issue(rule, pack, path, measured=_r(depth), limit=_r(limit),
                                 message=f"cavity {_r(depth)} mm deep, over {rule.params['max_ratio']:g} x the {tool:g} mm tool (width {_r(width)} mm)"))
    return issues


def corner_inner_auto_radius(facts, rule, pack):
    params = rule.params
    mated = _mated_paths(facts)
    issues = []
    for body, path, faces in _pocket_groups(facts):
        depth = _pocket_depth(faces)
        if depth <= 0:
            continue
        auto = depth / params["radius_ratio"]
        radii: list[float] = []
        walls = [f for f in faces if _is_vertical_wall(f)]
        for wall in walls:
            for edge in wall.face.Edges:
                if type(edge.Curve).__name__ != "Line" or abs(edge.Vertexes[-1].Point.z - edge.Vertexes[0].Point.z) < 1e-6 * max(edge.Length, 1):
                    continue
                for other in _adjacent(body, edge, exclude=wall.idx):
                    if other.idx in {w.idx for w in walls} and _edge_convex(edge, wall.centre, wall.normal, other.centre, other.normal) is False:
                        radii.append(0.0)
        for cylinder in faces:
            if _is_vertical_cylinder(cylinder):
                radii.append(cylinder.radius)
        if not radii:
            continue
        smallest = min(radii)
        if smallest >= auto - EPS:
            continue
        is_mated = any(m == path or m.startswith(path + "/") for m in mated)
        severity = params["mated_severity"] if is_mated else params["info_severity"]
        message = f"{path}: inner corner R{_r(smallest)} is under depth/{params['radius_ratio']:g} = {_r(auto)}; the platform machines R{_r(auto)}"
        if is_mated:
            message += " (this corner has a fit requirement)"
        issues.append(_issue(rule, pack, path, measured=_r(smallest), limit=_r(auto), severity=severity, message=message))
    return issues


def floor_chamfer(facts, rule, pack):
    issues = []
    for body, path, faces in _pocket_groups(facts):
        if any(_is_plane(f) and 0.05 < abs(f.normal.z) < 0.95 for f in faces):
            issues.append(_issue(rule, pack, path, message=f"{path}: a chamfer at the cavity floor leaves a step or fails; use an R corner"))
    return issues


def floor_fillet_radius(facts, rule, pack):
    minimum = rule.params["min_mm"]
    issues = []
    for body, path, faces in _pocket_groups(facts):
        for face in faces:
            if face.kind == "Cylinder" and not _is_vertical_cylinder(face):
                radius = face.radius
            elif face.kind == "Torus":
                radius = face.extra["minor"]
            else:
                continue
            if radius <= minimum + EPS:
                issues.append(_issue(rule, pack, path, measured=_r(radius), limit=minimum,
                                     message=f"{path}: cavity floor radius R{_r(radius)} must be greater than R{minimum:g}"))
                break
    return issues


def corner_relief_size(facts, rule, pack):
    tools = [t / 2 for t in pack.tables["tool_diameters_mm"]]
    issues = []
    for body in facts["bodies"]:
        box = body.bbox
        for face in body.faces:
            if not (face.kind == "Cylinder" and face.concave and _is_vertical_cylinder(face)):
                continue
            c = face.origin
            near_x = min(abs(c.x - box.XMin), abs(c.x - box.XMax)) <= face.radius * 2
            near_y = min(abs(c.y - box.YMin), abs(c.y - box.YMax)) <= face.radius * 2
            if not (near_x and near_y):
                continue
            if any(abs(face.radius - t) < 1e-3 for t in tools):
                issues.append(_issue(rule, pack, _target(body, face), measured=_r(face.radius), unit="mm",
                                     message=f"relief radius R{_r(face.radius)} equals the tool radius; it must be larger"))
    return issues


def outer_concave_narrow(facts, rule, pack):
    min_tool = rule.params["min_tool_mm"]
    issues = []
    for body, path, faces in _pocket_groups(facts):
        width, opens = _cavity_width(facts, body, faces)
        if opens and width is not None and width < min_tool - EPS:
            issues.append(_issue(rule, pack, path, measured=_r(width), limit=min_tool,
                                 message=f"open notch {_r(width)} mm wide cannot be milled (smallest tool φ{min_tool:g})"))
    return issues


# ---------------------------------------------------------------- walls

def wall_min_thickness(facts, rule, pack):
    limit = rule.params["min_mm"]
    issues: dict[str, dict[str, Any]] = {}
    for body in facts["bodies"]:
        for face in body.faces:
            found = _thickness(facts, body).get(face.idx)
            if found is None or found[0] >= limit - EPS:
                continue
            target = _target(body, face)
            key = json_key(target)
            if key not in issues or found[0] < issues[key]["measured"]:
                issues[key] = _issue(rule, pack, target, measured=_r(found[0]), limit=limit,
                                     message=f"wall {_r(found[0])} mm thick; at least {limit:g} mm is needed")
    return list(issues.values())


def wall_slender_suspended(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        thickness = _thickness(facts, body)
        floor = body.bbox.ZMin
        for face in body.faces:
            if not _is_vertical_wall(face) or face.idx not in thickness:
                continue
            value = thickness[face.idx][0]
            if value <= EPS:
                continue
            height = face.zmax - face.zmin
            span = max(face.bbox.XLength, face.bbox.YLength)
            ratio = max(height, span) / value
            if ratio <= SLENDER_ASPECT_INFERRED:
                continue
            if face.zmin <= floor + 1e-3 or _walls_on_floor(body, face, floor):
                continue  # the wall stands on the body's bottom
            issues.append(_issue(rule, pack, _target(body, face), measured=_r(ratio, 2), limit=SLENDER_ASPECT_INFERRED, unit="ratio",
                                 message=f"suspended slender wall {_r(value)} mm thick, ratio {_r(ratio, 1)} (inferred threshold {SLENDER_ASPECT_INFERRED:g})"))
    return issues


def _walls_on_floor(body: BodyFaces, wall: FaceInfo, floor: float) -> bool:
    """True when some face under the wall's bottom edge is a downward-facing planar face."""
    for edge in wall.face.Edges:
        z = [v.Point.z for v in edge.Vertexes]
        if not z or max(z) > wall.zmin + 1e-6 or min(z) < wall.zmin - 1e-6:
            continue
        for other in _adjacent(body, edge, exclude=wall.idx):
            if _is_plane(other) and other.normal.z < -1 + EPS:
                return True
    return False


# ---------------------------------------------------------------- two sides and outlines

def edge_double_side_chamfer(facts, rule, pack):
    params = rule.params
    issues = []
    for body in facts["bodies"]:
        mid = (body.bbox.ZMin + body.bbox.ZMax) / 2
        top, bottom = [], []
        for face in body.faces:
            if not (_is_plane(face) and 0.05 < abs(face.normal.z) < 0.95 and _touches_envelope(face, body)):
                continue
            size = face.zmax - face.zmin
            if face.zmin >= mid - 1e-6:
                top.append(size)
            elif face.zmax <= mid + 1e-6:
                bottom.append(size)
        if not top or not bottom:
            continue
        top_max, bottom_max = max(top), max(bottom)
        if top_max > params["side_min_mm"] + EPS and bottom_max > params["side_min_mm"] + EPS:
            issues.append(_issue(rule, pack, body.path,
                                 message=f"{body.path}: outline chamfers on both faces (C{_r(top_max)} top, C{_r(bottom_max)} bottom) may fail"))
    return issues


def edge_double_side_fillet(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        mid = (body.bbox.ZMin + body.bbox.ZMax) / 2
        top = bottom = False
        for face in body.faces:
            if _is_plane(face) or (face.kind == "Cylinder" and (face.concave or _is_vertical_cylinder(face))):
                continue
            if not _touches_envelope(face, body):
                continue
            if face.zmin >= mid - 1e-6:
                top = True
            elif face.zmax <= mid + 1e-6:
                bottom = True
        if top and bottom:
            issues.append(_issue(rule, pack, body.path, message=f"{body.path}: outline fillets on both faces; a rounded edge is only supported on one side"))
    return issues


def _bottom_recesses(facts: dict[str, Any], body: BodyFaces) -> dict[str, list[FaceInfo]]:
    """Pockets cut from the bottom face (all their faces)."""
    return {
        feature: faces for feature, faces in _cut_features(facts, body).items()
        if _opening_side(facts, body, feature) == "bottom"
    }


def twoside_back_notch_ratio(facts, rule, pack):
    standard = pack.tables["standard_thickness_mm"]
    dz = facts["bbox"][2]
    if not any(abs(dz - v) <= 1e-3 for v in standard):
        return []
    limit = rule.params["max_ratio"]
    issues = []
    for body in facts["bodies"]:
        box = body.bbox
        for feature, lower in _bottom_recesses(facts, body).items():
            x0 = min(f.bbox.XMin for f in lower)
            x1 = max(f.bbox.XMax for f in lower)
            y0 = min(f.bbox.YMin for f in lower)
            y1 = max(f.bbox.YMax for f in lower)
            ratio = max((x1 - x0) / box.XLength if box.XLength else 0, (y1 - y0) / box.YLength if box.YLength else 0)
            if ratio > limit + EPS:
                issues.append(_issue(rule, pack, feature, measured=_r(ratio), limit=limit, unit="ratio",
                                     message=f"back notch is {ratio:.0%} of the outline, over {limit:.0%}"))
    return issues


def twoside_nonstandard_back(facts, rule, pack):
    standard = pack.tables["standard_thickness_mm"]
    dz = facts["bbox"][2]
    if any(abs(dz - v) <= 1e-3 for v in standard):
        return []
    issues = []
    for body in facts["bodies"]:
        for feature, faces in _bottom_recesses(facts, body).items():
            if any(_is_vertical_wall(f) for f in faces):
                issues.append(_issue(rule, pack, feature, message=f"{feature}: a non-standard thickness allows only round counterbore steps on the back"))
    return issues


def twoside_max_outline_top(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        levels = sorted({round(f.centre.z, 4) for f in body.faces if _is_horizontal_face(f)})
        merged: list[float] = []
        for level in levels:
            if not merged or level - merged[-1] > 1e-4:
                merged.append(level)
        if len(merged) < 3:
            continue
        areas = []
        for low, high in zip(merged, merged[1:]):
            _tick(facts)
            mid = (low + high) / 2
            areas.append(_outline_area(body, mid))
        best = max(areas)
        ends = [areas[0], areas[-1]]
        if any(a >= best * (1 - 1e-6) for a in ends):
            continue
        middle = areas.index(best)
        issues.append(_issue(rule, pack, body.path,
                             message=f"the largest outline is at z {_r((merged[middle] + merged[middle + 1]) / 2)} mm, not on the top or bottom face; a two-sided boss will fail"))
    return issues


def _outline_area(body: BodyFaces, z: float) -> float:
    box = body.bbox
    slab = Part.makeBox(box.XLength + 2, box.YLength + 2, 2e-3, App.Vector(box.XMin - 1, box.YMin - 1, z - 1e-3))
    common = body.world.common(slab)
    if common.isNull():
        return 0.0
    cut = common.BoundBox
    return cut.XLength * cut.YLength


def _blend_face_ids(facts: dict[str, Any], body: BodyFaces) -> set[int]:
    """Faces of fillets and chamfers: recognized blends (reify-asi) and faces of PartDesign fillet or chamfer features."""
    ids: set[int] = set()
    asi = (facts["asi"] or {}).get(body.path)
    if asi is not None:
        for blend in asi.get("blends", []):
            ids.update(int(i) for i in blend.get("faces", []))
    for face in body.faces:
        if _feature_type(facts, face.feature) in ("PartDesign::Fillet", "PartDesign::Chamfer"):
            ids.add(face.idx)
    return ids


def surface_double_side_curved(facts, rule, pack):
    """Curved faces on both the top and the bottom. Fillets and chamfers are left to edge.double_side_fillet."""
    issues = []
    for body in facts["bodies"]:
        top = bottom = False
        blends = _blend_face_ids(facts, body)
        for face in body.faces:
            if _is_plane(face) or _is_vertical_cylinder(face) or face.idx in blends:
                continue  # planes, vertical hole walls and blends are not curved surfaces to machine from this side
            if face.normal.z > 0.1:
                top = True
            elif face.normal.z < -0.1:
                bottom = True
        if top and bottom:
            issues.append(_issue(rule, pack, body.path, message=f"{body.path}: curved surfaces on both the top and the bottom; a curved face is only supported on one side (ball end mill D{rule.params['ball_min_diameter_mm']:g} minimum)"))
    return issues


def surface_multi_face(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        asi = (facts["asi"] or {}).get(body.path)
        if asi is None:
            continue
        for blend in asi.get("blends", []):
            faces = [body.by_index[i] for i in blend.get("faces", []) if i in body.by_index]
            if len(faces) < 2 or not any(abs(f.normal.z) < 0.7 for f in faces):
                continue
            first = faces[0]
            issues.append(_issue(rule, pack, _target(body, first), measured=len(faces), unit="faces",
                                 message=f"a feature of {len(faces)} faces on the side leaves tool marks"))
    return issues


def ganging_forbidden(facts, rule, pack):
    issues = []
    for body in facts["bodies"]:
        box = body.bbox
        lengths = [box.XLength, box.YLength, box.ZLength]
        axis = lengths.index(max(lengths))
        lo = [box.XMin, box.YMin, box.ZMin][axis]
        hi = [box.XMax, box.YMax, box.ZMax][axis]
        span = hi - lo
        if span <= 0:
            continue
        positions = set()
        for face in body.faces:
            if _is_plane(face) and abs(abs(face.normal.dot(_unit(axis))) - 1) < 1e-4:
                positions.add(round(_component(face.centre, axis), 4))
        ordered = sorted(positions)
        cuts = [(a + b) / 2 for a, b in zip(ordered, ordered[1:])]
        cuts += [lo + span * (i + 0.5) / GANG_SAMPLES for i in range(GANG_SAMPLES)]
        step = span / 200.0
        areas = {c: _slab_area(facts, body, axis, c, step) for c in cuts}
        peak = max(areas.values()) if areas else 0.0
        if peak <= 0:
            continue
        total = body.world.Volume
        for c in sorted(cuts):
            if areas[c] >= GANG_NECK_SHARE_INFERRED * peak:
                continue
            left, right = _sides_volume(body, axis, lo, c, hi)
            if total > 0 and left > GANG_SIDE_SHARE_INFERRED * total and right > GANG_SIDE_SHARE_INFERRED * total:
                issues.append(_issue(rule, pack, body.path, measured=_r(areas[c] / peak, 3), limit=GANG_NECK_SHARE_INFERRED, unit="ratio",
                                     message=f"two parts are joined by a neck {_r(areas[c] / peak * 100, 1)}% of the largest section (inferred threshold {GANG_NECK_SHARE_INFERRED:.0%}; both sides over {GANG_SIDE_SHARE_INFERRED:.0%} of the volume)"))
                break
    return issues


def _unit(axis: int) -> Any:
    return App.Vector(*[1 if i == axis else 0 for i in range(3)])


def _component(vector: Any, axis: int) -> float:
    return (vector.x, vector.y, vector.z)[axis]


def _slab_area(facts: dict[str, Any], body: BodyFaces, axis: int, c: float, thickness: float) -> float:
    _tick(facts)
    box = body.bbox
    origin = [box.XMin - 1, box.YMin - 1, box.ZMin - 1]
    size = [box.XLength + 2, box.YLength + 2, box.ZLength + 2]
    origin[axis] = c - thickness / 2
    size[axis] = thickness
    slab = Part.makeBox(size[0], size[1], size[2], App.Vector(*origin))
    common = body.world.common(slab)
    return common.Volume / thickness if not common.isNull() else 0.0


def _sides_volume(body: BodyFaces, axis: int, lo: float, c: float, hi: float) -> tuple[float, float]:
    box = body.bbox
    base = [box.XMin - 1, box.YMin - 1, box.ZMin - 1]
    size = [box.XLength + 2, box.YLength + 2, box.ZLength + 2]
    left_size = list(size)
    left_size[axis] = c - base[axis]
    right_origin = list(base)
    right_origin[axis] = c
    right_size = list(size)
    right_size[axis] = base[axis] + size[axis] - c
    left = body.world.common(Part.makeBox(*left_size, App.Vector(*base))).Volume
    right = body.world.common(Part.makeBox(*right_size, App.Vector(*right_origin))).Volume
    return left, right


GEOMETRY_CHECKS: dict[str, GeometryCheck] = {
    "stock_side_height": stock_side_height,
    "stock_standard_thickness": stock_standard_thickness,
    "stock_thin_plate_large": stock_thin_plate_large,
    "hole_min_diameter": hole_min_diameter,
    "hole_depth_ratio": hole_depth_ratio,
    "hole_thread_tap_drill": hole_thread_tap_drill,
    "hole_thread_side_wall": hole_thread_side_wall,
    "hole_blind_bottom_wall": hole_blind_bottom_wall,
    "hole_bottom_shape": hole_bottom_shape,
    "hole_internal_chamfer": hole_internal_chamfer,
    "hole_ring_groove": hole_ring_groove,
    "hole_countersink": hole_countersink,
    "hole_countersink_to_bottom": hole_countersink_to_bottom,
    "hole_side_support_face": hole_side_support_face,
    "hole_waist_slot_depth": hole_waist_slot_depth,
    "cavity_min_width": cavity_min_width,
    "cavity_depth_tool_ratio": cavity_depth_tool_ratio,
    "corner_inner_auto_radius": corner_inner_auto_radius,
    "corner_relief_size": corner_relief_size,
    "floor_chamfer": floor_chamfer,
    "floor_fillet_radius": floor_fillet_radius,
    "outer_concave_narrow": outer_concave_narrow,
    "wall_min_thickness": wall_min_thickness,
    "wall_slender_suspended": wall_slender_suspended,
    "edge_double_side_chamfer": edge_double_side_chamfer,
    "edge_double_side_fillet": edge_double_side_fillet,
    "twoside_back_notch_ratio": twoside_back_notch_ratio,
    "twoside_nonstandard_back": twoside_nonstandard_back,
    "twoside_max_outline_top": twoside_max_outline_top,
    "surface_double_side_curved": surface_double_side_curved,
    "surface_multi_face": surface_multi_face,
    "ganging_forbidden": ganging_forbidden,
}
