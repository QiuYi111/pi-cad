"""Semantic face and edge roles (imports FreeCAD).

A face has no stable handle across rebuilds, so a feature's faces are found
again from geometry the feature itself defines:

* The faces a feature *created* are the faces of its result whose underlying
  surface does not exist in the shape it was applied to.
* A face of the final body belongs to a created face when both lie on the
  same surface and the final face stays inside the created one (later
  features may trim or split it, never move it).
* Roles come from how a face relates to the feature's sketch plane.

FreeCAD's element map (``getElementMappedName``) names faces too, but it
rewrites a face's name when a later feature touches the face, so it cannot
tell a pad's top face from the same face after a hole was cut through it.
Geometry is the rule here, and ``ROLE_FALLBACK_GEOMETRIC`` is therefore never
needed: it is reported only when a role cannot be derived at all.
"""

from __future__ import annotations

import functools
import math
import re
from dataclasses import dataclass, field
from typing import Any

import FreeCAD as App
import Part

from .core import body_features, get_path, owning_body, similar_paths
from .errors import ReifyOpError

_ROLE_INDEX = re.compile(r"^(?P<base>[a-z_]+)\.(?P<index>\d+)$")


@dataclass
class RoleFace:
    face_name: str
    face: Any


@dataclass
class BodyRoles:
    """Roles of one body, found in the body's local frame.

    Features and sketches live in the local frame of their body; only the body
    carries the pose. ``shape`` is therefore the body shape with the pose
    removed, and every consumer that needs world coordinates goes through
    ``to_world``.
    """

    body: Any
    shape: Any
    placement: Any = None
    #: "feature/role" -> final-shape faces (FaceN names in ``shape``)
    faces: dict[str, list[RoleFace]] = field(default_factory=dict)
    #: "feature/role" -> final-shape edge names
    edges: dict[str, list[str]] = field(default_factory=dict)
    warnings: list[dict[str, Any]] = field(default_factory=list)

    def to_world(self, shape: Any) -> Any:
        placed = shape.copy()
        placed.Placement = self.placement.multiply(placed.Placement)
        return placed

    def point_to_world(self, point: Any) -> Any:
        return self.placement.multVec(point)


# ---------------------------------------------------------------- geometry

def _tolerance(shape: Any) -> float:
    box = shape.BoundBox
    return max(1e-6, 1e-7 * max(box.DiagonalLength, 1.0)) * 100


def _close(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


def _parallel(u: Any, v: Any, tol: float = 1e-6) -> bool:
    return u.cross(v).Length <= tol * max(u.Length * v.Length, 1e-12)


def same_surface(f1: Any, f2: Any, tol: float) -> bool:
    s1, s2 = f1.Surface, f2.Surface
    if type(s1) is not type(s2):
        return False
    if isinstance(s1, Part.Plane):
        if not _parallel(s1.Axis, s2.Axis):
            return False
        return _close((s2.Position - s1.Position).dot(s1.Axis), 0.0, tol)
    if isinstance(s1, Part.Cylinder):
        if not _parallel(s1.Axis, s2.Axis) or not _close(s1.Radius, s2.Radius, tol):
            return False
        offset = s2.Center - s1.Center
        perpendicular = offset - s1.Axis * offset.dot(s1.Axis)
        return perpendicular.Length <= tol
    if isinstance(s1, Part.Cone):
        if not _parallel(s1.Axis, s2.Axis) or not _close(s1.SemiAngle, s2.SemiAngle, 1e-6):
            return False
        return (s1.Apex - s2.Apex).Length <= tol
    if isinstance(s1, Part.Sphere):
        return _close(s1.Radius, s2.Radius, tol) and (s1.Center - s2.Center).Length <= tol
    if isinstance(s1, Part.Toroid):
        return (
            _parallel(s1.Axis, s2.Axis) and _close(s1.MajorRadius, s2.MajorRadius, tol)
            and _close(s1.MinorRadius, s2.MinorRadius, tol) and (s1.Center - s2.Center).Length <= tol
        )
    return (
        _close(f1.Area, f2.Area, tol * max(1.0, f1.Area) * 1e-3)
        and (f1.CenterOfMass - f2.CenterOfMass).Length <= tol
    )


def face_within(inner: Any, outer: Any, tol: float) -> bool:
    """True when ``inner`` (same surface as ``outer``) lies inside ``outer``."""
    if inner.Area > outer.Area * (1 + 1e-6) + tol:
        return False
    points = [vertex.Point for vertex in inner.Vertexes] or [inner.CenterOfMass]
    for point in points:
        if outer.distToShape(Part.Vertex(point))[0] > tol * 10:
            return False
    return True


def _boxes(faces: list[Any]) -> list[tuple[Any, Any]]:
    """(face, bounding box) pairs: the box test below is much cheaper than ``same_surface`` and ``distToShape``."""
    return [(face, face.BoundBox) for face in faces]


def _within_box(inner_box: Any, outer_box: Any, margin: float) -> bool:
    """False when ``inner`` cannot lie inside ``outer`` (``face_within`` accepts points up to ``margin`` away)."""
    return not (
        inner_box.XMax < outer_box.XMin - margin or inner_box.XMin > outer_box.XMax + margin
        or inner_box.YMax < outer_box.YMin - margin or inner_box.YMin > outer_box.YMax + margin
        or inner_box.ZMax < outer_box.ZMin - margin or inner_box.ZMin > outer_box.ZMax + margin
    )


def _lies_on(face: Any, candidates: list[tuple[Any, Any]], tol: float) -> bool:
    """True when ``face`` has the surface of one of ``candidates`` and lies inside it."""
    box = face.BoundBox
    return any(
        _within_box(box, other_box, tol * 10 + 1e-9) and same_surface(face, other, tol) and face_within(face, other, tol)
        for other, other_box in candidates
    )


def contained_in_base(face: Any, base: Any | None, tol: float) -> bool:
    """True when ``face`` already existed in ``base``: same surface, and inside a face of it.

    The surface alone is not enough: a boss whose top is flush with a tower top
    lies on the tower's plane but is a new face.
    """
    if base is None or base.isNull():
        return False
    return _lies_on(face, _boxes(base.Faces), tol)


#: (document name, feature name) -> (feature shape, base shape, tolerance, created faces, their indices).
#: Finding the created faces costs a distance query per face and feature, and every recompute
#: asked for all of them again: the cost of building a part grew with the square of its feature
#: count. A feature that was not recomputed keeps its ``TopoDS`` shape, so ``isSame`` on the
#: feature shape and on its base shape is an exact test that the cached answer still holds.
_CREATED_CACHE: dict[tuple[str, str], tuple[Any, Any, float, list[Any], list[int]]] = {}
_CREATED_CACHE_LIMIT = 4096
CREATED_CACHE_SCHEMA = 1
#: Searches done (cache misses) since the process started; the tests and slow-request diagnosis read it.
STATS = {"created_searches": 0}


def _same_shape(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    return a.isSame(b)


def _close_tol(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def created_faces(feature: Any, tol: float) -> list[Any]:
    """Faces of ``feature.Shape`` that did not exist in its base shape."""
    base = getattr(feature, "BaseFeature", None)
    base_shape = base.Shape if base is not None else None
    shape = feature.Shape
    key = (feature.Document.Name, feature.Name)
    hit = _CREATED_CACHE.get(key)
    if hit is not None and _close_tol(hit[2], tol) and _same_shape(hit[0], shape) and _same_shape(hit[1], base_shape):
        return list(hit[3])
    STATS["created_searches"] += 1
    faces = list(shape.Faces)
    if base_shape is None or base_shape.isNull():
        indices = list(range(len(faces)))
    else:
        base_faces = _boxes(base_shape.Faces)  # once per feature, not once per face
        indices = [i for i, face in enumerate(faces) if not _lies_on(face, base_faces, tol)]
    created = [faces[i] for i in indices]
    if len(_CREATED_CACHE) >= _CREATED_CACHE_LIMIT:
        _CREATED_CACHE.clear()
    _CREATED_CACHE[key] = (shape, base_shape, tol, created, indices)
    return list(created)


def _face_print(face: Any) -> list[float]:
    centre = face.CenterOfMass
    return [round(face.Area, 4), round(centre.x, 3), round(centre.y, 3), round(centre.z, 3)]


def export_created_cache(doc: Any) -> dict[str, Any]:
    """The created faces of every feature of ``doc`` that are still valid, as face indices with a fingerprint.

    Saved next to the document so that reopening it (a restart of the worker, or the reload
    after a rolled-back apply) does not find them again. Indices are only trusted when the
    fingerprint of every face matches on import.
    """
    entries: dict[str, Any] = {}
    for obj in doc.Objects:
        hit = _CREATED_CACHE.get((doc.Name, obj.Name))
        if hit is None or not _same_shape(hit[0], obj.Shape):
            continue
        base = getattr(obj, "BaseFeature", None)
        if not _same_shape(hit[1], base.Shape if base is not None else None):
            continue
        faces = hit[0].Faces
        entries[obj.Name] = {
            "tol": hit[2], "faces": len(faces), "baseFaces": len(hit[1].Faces) if hit[1] is not None else None,
            "created": hit[4], "prints": [_face_print(faces[i]) for i in hit[4]],
        }
    return {"schema": CREATED_CACHE_SCHEMA, "features": entries}


def import_created_cache(doc: Any, data: dict[str, Any]) -> int:
    """Seed the cache from ``export_created_cache`` of the same saved file; returns the entries accepted."""
    if not isinstance(data, dict) or data.get("schema") != CREATED_CACHE_SCHEMA:
        return 0
    accepted = 0
    for name, entry in (data.get("features") or {}).items():
        try:
            obj = doc.getObject(name)
            if obj is None or obj.Shape.isNull():
                continue
            shape = obj.Shape
            base = getattr(obj, "BaseFeature", None)
            base_shape = base.Shape if base is not None else None
            faces = shape.Faces
            if len(faces) != entry["faces"] or (len(base_shape.Faces) if base_shape is not None else None) != entry["baseFaces"]:
                continue
            indices = [int(i) for i in entry["created"]]
            if any(i < 0 or i >= len(faces) for i in indices):
                continue
            if any(_face_print(faces[i]) != print_ for i, print_ in zip(indices, entry["prints"])):
                continue
            _CREATED_CACHE[(doc.Name, name)] = (shape, base_shape, float(entry["tol"]), [faces[i] for i in indices], indices)
            accepted += 1
        except Exception:
            continue
    return accepted


# ---------------------------------------------------------------- sketch helpers

def sketch_plane_info(sketch: Any) -> tuple[Any, Any]:
    """(origin point, unit normal) of a sketch's plane in global coordinates."""
    placement = sketch.Placement
    return placement.Base, placement.Rotation.multVec(App.Vector(0, 0, 1))


def sketch_edges(sketch: Any) -> list[Any]:
    """Global shapes of the non-construction geometry, in sketch geometry order."""
    shapes = []
    for index, geometry in enumerate(sketch.Geometry):
        if sketch.getConstruction(index):
            continue
        shape = geometry.toShape()
        shape.Placement = sketch.Placement
        shapes.append(shape)
    return shapes


def _owner_geometry_index(face: Any, sketch: Any, tol: float) -> int | None:
    """Index of the non-construction sketch geometry whose midpoint lies on ``face``.

    The midpoint is used because a later feature may trim the face so that the
    sketch edge no longer lies on it from end to end.
    """
    for index, edge in enumerate(sketch_edges(sketch)):
        if not edge.Edges:
            continue
        middle = edge.valueAt((edge.FirstParameter + edge.LastParameter) / 2)
        if face.distToShape(Part.Vertex(middle))[0] <= tol * 10:
            return index
    return None


def _along(face: Any, origin: Any, normal: Any) -> float:
    return (face.CenterOfMass - origin).dot(normal)


# ---------------------------------------------------------------- role assignment

def _plane_normal(face: Any) -> Any:
    return face.Surface.Axis


def roles_for_feature(feature: Any, created: list[Any], tol: float) -> dict[str, list[Any]]:
    """Role name -> created faces (global shapes of ``feature.Shape``)."""
    kind = feature.TypeId
    out: dict[str, list[Any]] = {}

    def put(role: str, face: Any) -> None:
        out.setdefault(role, []).append(face)

    profile = getattr(feature, "Profile", None)
    sketch = profile[0] if isinstance(profile, tuple) else profile
    origin, normal = sketch_plane_info(sketch) if sketch is not None and sketch.TypeId == "Sketcher::SketchObject" else (App.Vector(), App.Vector(0, 0, 1))

    if kind == "PartDesign::Pad":
        planar = [f for f in created if isinstance(f.Surface, Part.Plane) and _parallel(f.Surface.Axis, normal)]
        direction = -1.0 if feature.Reversed else 1.0
        # bottom = the end face on the sketch plane, top = the far end face.
        ordered = sorted(planar, key=lambda f: (round(abs(_along(f, origin, normal)), 6), -direction * _along(f, origin, normal)))
        side_candidates = [f for f in created if f not in planar]
        if len(ordered) >= 2:
            put("bottom", ordered[0])
            put("top", ordered[-1])
            side_candidates.extend(ordered[1:-1])
        elif len(ordered) == 1:
            put("top", ordered[0])
        _number_sides(out, side_candidates, sketch, "side", tol)
    elif kind == "PartDesign::Pocket":
        planar = [f for f in created if isinstance(f.Surface, Part.Plane) and _parallel(f.Surface.Axis, normal)]
        floors = sorted(planar, key=lambda f: abs(_along(f, origin, normal)))
        if floors:
            put("floor", floors[-1])
        walls = [f for f in created if all(f is not other for other in floors[-1:])]
        _number_sides(out, walls, sketch, "wall", tol)
    elif kind == "PartDesign::Hole":
        _hole_roles(feature, created, out, origin, normal)
    elif kind == "PartDesign::Fillet":
        for face in created:
            put("round", face)
    elif kind == "PartDesign::Chamfer":
        for face in created:
            put("bevel", face)
    return out


def _number_sides(out: dict[str, list[Any]], faces: list[Any], sketch: Any, role: str, tol: float) -> None:
    unnumbered: list[Any] = []
    for face in faces:
        index = _owner_geometry_index(face, sketch, tol) if sketch is not None else None
        if index is None:
            unnumbered.append(face)
        else:
            out.setdefault(f"{role}.{index}", []).append(face)
    for position, face in enumerate(unnumbered):
        out.setdefault(f"{role}.x{position}", []).append(face)


def _hole_roles(feature: Any, created: list[Any], out: dict[str, list[Any]], origin: Any, normal: Any) -> None:
    diameter = float(feature.Diameter.Value) if hasattr(feature.Diameter, "Value") else float(feature.Diameter)
    cylinders = [f for f in created if isinstance(f.Surface, Part.Cylinder)]
    cones = [f for f in created if isinstance(f.Surface, Part.Cone)]
    planes = sorted((f for f in created if isinstance(f.Surface, Part.Plane)), key=lambda f: _along(f, origin, normal))
    main = [f for f in cylinders if abs(f.Surface.Radius * 2 - diameter) < 1e-4 * max(diameter, 1)]
    for face in main:
        out.setdefault("wall", []).append(face)
    for face in cylinders:
        if face not in main:
            out.setdefault("counterbore_wall", []).append(face)
    # A cone is the countersink when the hole has one and it is the cone nearest the opening;
    # any other cone is the angled drill point at the bottom of a blind hole.
    countersunk = str(getattr(feature, "HoleCutType", "None")) == "Countersink"
    entry_first = sorted(cones, key=lambda f: -_along(f, origin, normal))
    for position, face in enumerate(entry_first):
        out.setdefault("countersink" if countersunk and position == 0 else "bottom", []).append(face)
    has_cut = str(getattr(feature, "HoleCutType", "None")) != "None"
    through = str(getattr(feature, "DepthType", "Dimension")) == "ThroughAll"
    if through:
        floors = planes  # a through hole has no bottom; planes belong to the counterbore
    elif has_cut and len(planes) >= 2:
        out.setdefault("bottom", []).append(planes[0])
        floors = planes[1:]
    elif has_cut and planes and not main:
        floors = planes
    else:
        floors = []
        for face in planes:
            out.setdefault("bottom", []).append(face)
    for face in floors:
        out.setdefault("counterbore_floor", []).append(face)


# ---------------------------------------------------------------- body-level index

def _final_faces(shape: Any, created: list[Any], tol: float) -> list[tuple[int, Any]]:
    """(1-based face index, face) of ``shape`` that lie on a created face."""
    matches: list[tuple[int, Any]] = []
    sources = _boxes(created)
    for position, face in enumerate(shape.Faces, 1):
        if _lies_on(face, sources, tol):
            matches.append((position, face))
    return matches


def compute_body_roles(body: Any) -> BodyRoles:
    shape = body.Shape.copy()
    placement = body.Placement
    shape.Placement = App.Placement()
    result = BodyRoles(body=body, shape=shape, placement=placement)
    if shape.isNull() or not shape.Faces:
        return result
    tol = _tolerance(shape)
    claimed: set[int] = set()
    features = body_features(body)
    created_by_feature: dict[str, tuple[Any, dict[str, list[Any]]]] = {}
    for feature in features:
        path = get_path(feature)
        if not path or feature.Shape.isNull():
            continue
        try:
            created = created_faces(feature, tol)
            roles = roles_for_feature(feature, created, tol)
        except Exception as error:  # a role failure must not take the build down
            result.warnings.append({"code": "ROLE_FALLBACK_GEOMETRIC", "target": path, "detail": {"reason": str(error)}})
            continue
        created_by_feature[path] = (feature, roles)
        for role, role_faces in roles.items():
            for position, face in _final_faces(shape, role_faces, tol):
                if position in claimed:
                    continue  # the earliest feature that created this surface keeps it
                claimed.add(position)
                result.faces.setdefault(f"{path}/{role}", []).append(RoleFace(f"Face{position}", face))
    _pattern_roles(result, features, created_by_feature, tol, claimed)
    _distinct_names(result, {path: feature for path, (feature, _roles) in created_by_feature.items()}, tol)
    _edge_roles(result, {path: feature for path, (feature, _roles) in created_by_feature.items()})
    return result


#: Roles that name a group of faces on purpose (one round per filleted edge); they keep one name.
GROUP_ROLES = frozenset({"round", "bevel"})

#: Separator of the pieces of one role: ``side.0~0``, ``side.0~1``.
PIECE_SEPARATOR = "~"


def role_base(role: str) -> str:
    """``wall.3@2~1`` -> ``wall``."""
    return re.split(r"[.@~]", role, maxsplit=1)[0]


def _feature_frame(feature: Any) -> tuple[Any, Any, Any, Any]:
    """(origin, u, v, normal) of the feature's sketch, or the global frame."""
    profile = getattr(feature, "Profile", None) if feature is not None else None
    sketch = profile[0] if isinstance(profile, tuple) else profile
    if sketch is not None and getattr(sketch, "TypeId", "") == "Sketcher::SketchObject":
        rotation = sketch.Placement.Rotation
        return (sketch.Placement.Base, rotation.multVec(App.Vector(1, 0, 0)), rotation.multVec(App.Vector(0, 1, 0)), rotation.multVec(App.Vector(0, 0, 1)))
    return App.Vector(), App.Vector(1, 0, 0), App.Vector(0, 1, 0), App.Vector(0, 0, 1)


def _order_key(face: Any, frame: tuple[Any, Any, Any, Any]) -> tuple[float, ...]:
    """Geometric position of a face in the feature's frame; faces of one role are ordered by it.

    A face of revolution is placed first, by (where its axis crosses the sketch plane, distance along the
    axis, angle of its centre about the axis counted from the sketch u axis), so four holes of one sketch,
    the two halves of a seam-split cylinder and the two bands
    of a grooved shaft each get a fixed order. Any other face follows, placed by (normal, v, u).
    """
    origin, u, v, n = frame
    point = face.CenterOfMass
    surface = face.Surface
    if isinstance(surface, (Part.Cylinder, Part.Cone)):
        axis = App.Vector(surface.Axis)
        for reference in (n, u, v):
            lean = axis.dot(reference)
            if abs(lean) > 1e-9:
                if lean < 0:
                    axis = axis * -1
                break
        centre = surface.Center if isinstance(surface, Part.Cylinder) else surface.Apex
        axial = (point - origin).dot(axis)
        radial = (point - centre) - axis * (point - centre).dot(axis)
        reference = u - axis * u.dot(axis)
        if reference.Length < 1e-9:
            reference = v - axis * v.dot(axis)
        reference.normalize()
        angle = 0.0
        if radial.Length > 1e-7:
            angle = math.degrees(math.atan2(radial.dot(axis.cross(reference)), radial.dot(reference))) % 360.0
            if angle > 360.0 - 1e-3:
                angle = 0.0
        return (0.0, (centre - origin).dot(u), (centre - origin).dot(v), axial, angle)
    offset = point - origin
    return (1.0, offset.dot(n), offset.dot(v), offset.dot(u))


def _shares_a_surface(entries: list[RoleFace], tol: float) -> bool:
    """True when two faces of the role lie on one surface (or are of different kinds): not a group of equals.

    Four holes drilled from one sketch share the role ``wall`` on purpose (four different
    cylinders); the two bands of a grooved shaft are one cylinder cut in two.
    """
    pairs = [(a.face, b.face) for i, a in enumerate(entries) for b in entries[i + 1:]]
    return any(type(a.Surface) is not type(b.Surface) or same_surface(a, b, tol) for a, b in pairs)


def _distinct_names(result: BodyRoles, features: dict[str, Any], tol: float) -> None:
    """Give the pieces of a split face their own names: ``role~0``, ``role~1``...

    A role that holds several faces on different surfaces (four holes of one sketch) is a group and
    keeps its one name. A later feature splits one created face into pieces that all inherit its role (a groove
    cuts a shaft's side into two bands, and OCC cuts a cylinder at its seam), and a selector
    must be able to tell them apart. Pieces are numbered by ``_order_key``, so the numbers
    survive dimension edits that keep the topology. ``side.0`` still selects all of them.
    """
    renamed: dict[str, list[RoleFace]] = {}
    for key, entries in result.faces.items():
        path, _, role = key.rpartition("/")
        if len(entries) < 2 or role_base(role) in GROUP_ROLES or not _shares_a_surface(entries, tol):
            renamed[key] = entries
            continue
        frame = _feature_frame(features.get(path))
        keyed = [(_order_key(entry.face, frame), entry) for entry in entries]

        def compare(a: tuple[tuple[float, ...], RoleFace], b: tuple[tuple[float, ...], RoleFace]) -> int:
            for x, y in zip(a[0], b[0]):
                if abs(x - y) > tol * 10:
                    return -1 if x < y else 1
            return 0

        for position, (_k, entry) in enumerate(sorted(keyed, key=functools.cmp_to_key(compare))):
            renamed[f"{key}{PIECE_SEPARATOR}{position}"] = [entry]
    result.faces = renamed


def _pattern_roles(result: BodyRoles, features: list[Any], created_by_feature: dict[str, tuple[Any, dict[str, list[Any]]]], tol: float, claimed: set[int]) -> None:
    """Instances of patterned and mirrored features: ``<original role>@<n>`` (n >= 2)."""
    for feature in features:
        kind = feature.TypeId
        if kind not in ("PartDesign::LinearPattern", "PartDesign::PolarPattern", "PartDesign::Mirrored"):
            continue
        path = get_path(feature)
        if not path or feature.Shape.isNull():
            continue
        originals = []
        for original in feature.Originals:
            original_path = get_path(original)
            if original_path in created_by_feature:
                originals.append((original_path, created_by_feature[original_path][1]))
        if not originals:
            continue
        try:
            created = created_faces(feature, tol)
        except Exception:
            continue
        for face in created:
            placed = _instance_of(feature, face, originals, tol)
            if placed is None:
                continue
            original_path, role, instance = placed
            for position, final in _final_faces(result.shape, [face], tol):
                if position in claimed:
                    continue
                claimed.add(position)
                result.faces.setdefault(f"{original_path}/{role}@{instance}", []).append(RoleFace(f"Face{position}", final))


def _instance_of(feature: Any, face: Any, originals: list[tuple[str, dict[str, list[Any]]]], tol: float) -> tuple[str, str, int] | None:
    best: tuple[float, str, str, int] | None = None
    for original_path, roles in originals:
        for role, role_faces in roles.items():
            for source in role_faces:
                if type(source.Surface) is not type(face.Surface) or abs(source.Area - face.Area) > 1e-6 * max(1.0, source.Area):
                    continue
                instance, residual = _instance_number(feature, source, face)
                if instance is None:
                    continue
                if best is None or residual < best[0]:
                    best = (residual, original_path, role, instance)
    return (best[1], best[2], best[3]) if best and best[0] < 0.1 else None


def _instance_number(feature: Any, source: Any, face: Any) -> tuple[int | None, float]:
    delta = face.CenterOfMass - source.CenterOfMass
    if feature.TypeId == "PartDesign::Mirrored":
        return 2, 0.0
    count = int(feature.Occurrences)
    if feature.TypeId == "PartDesign::LinearPattern":
        direction = _pattern_direction(feature)
        length = float(feature.Length.Value if hasattr(feature.Length, "Value") else feature.Length)
        spacing = length / (count - 1) if count > 1 and str(feature.Mode) == "Extent" else length
        if spacing <= 0:
            return None, 1.0
        t = delta.dot(direction) / spacing
        return round(t) + 1, abs(t - round(t))
    axis = _pattern_direction(feature)
    angle = float(feature.Angle.Value if hasattr(feature.Angle, "Value") else feature.Angle)
    step = angle / count if abs(angle - 360.0) < 1e-9 else angle / max(count - 1, 1)
    a = source.CenterOfMass - axis * source.CenterOfMass.dot(axis)
    b = face.CenterOfMass - axis * face.CenterOfMass.dot(axis)
    if a.Length < 1e-9 or b.Length < 1e-9:
        return None, 1.0
    cross = a.cross(b)
    turned = math.degrees(math.atan2(cross.dot(axis), a.dot(b)))
    t = turned / step if step else 0.0
    if feature.Reversed:
        t = -t
    t = t % count if count else t
    return round(t) + 1, abs(t - round(t))


def _pattern_direction(feature: Any) -> Any:
    reference = feature.Direction if feature.TypeId == "PartDesign::LinearPattern" else feature.Axis
    obj, subs = reference if isinstance(reference, tuple) else (reference, [""])
    sub = subs[0] if subs else ""
    if obj is not None and obj.isDerivedFrom("App::Line"):
        vector = obj.Placement.Rotation.multVec(App.Vector(1, 0, 0))
    elif obj is not None and obj.isDerivedFrom("Sketcher::SketchObject") and sub.startswith("Axis"):
        vector = obj.Placement.Rotation.multVec(App.Vector(1, 0, 0))
    else:
        vector = App.Vector(1, 0, 0)
    if feature.Reversed:
        vector = vector * -1
    return vector


#: Direction towards the camera of the iso view, the first image the Agent sees.
ISO_TOWARDS_CAMERA = (-1.0, -1.0, 1.0)


def _towards_camera(face: Any, point: Any) -> float:
    try:
        u, v = face.Surface.parameter(point)
        normal = face.normalAt(u, v)
    except Exception:
        return 0.0
    return sum(a * b for a, b in zip((normal.x, normal.y, normal.z), ISO_TOWARDS_CAMERA)) / math.sqrt(3.0)


def label_anchor(face: Any) -> tuple[Any, float]:
    """(anchor point on the face, visibility weight).

    Planar faces turned towards the iso camera are labelled at their centre. A
    curved face (a hole wall) is labelled at the camera-facing point nearest to
    the camera, which is where its rim shows. A face turned away gets a low
    weight so a visible face of the same feature is preferred.
    """
    point = surface_anchor(face)
    if isinstance(face.Surface, Part.Plane):
        return point, 1.0 if _towards_camera(face, point) > 0.1 else 0.05
    best: tuple[float, Any] | None = None
    try:
        u0, u1, v0, v1 = face.ParameterRange
        for i in range(9):
            for j in range(9):
                candidate = face.valueAt(u0 + (u1 - u0) * (i + 0.5) / 9, v0 + (v1 - v0) * (j + 0.5) / 9)
                if not face.isInside(candidate, 1e-6, True) or _towards_camera(face, candidate) <= 0.1:
                    continue
                score = sum(a * b for a, b in zip((candidate.x, candidate.y, candidate.z), ISO_TOWARDS_CAMERA))
                if best is None or score > best[0]:
                    best = (score, candidate)
    except Exception:
        pass
    return (best[1], 1.0) if best else (point, 0.05)


def surface_anchor(face: Any) -> Any:
    """A point that lies on ``face`` itself (label anchor).

    The centre of mass of a hole wall is on the axis and of a plate with a hole
    may be inside the hole, so it is not on the face. This returns the centre
    of mass when it is, else the on-face point of a parameter grid nearest to it.
    """
    centre = face.CenterOfMass
    try:
        if isinstance(face.Surface, Part.Plane) and face.isInside(centre, 1e-6, True):
            return centre
        u0, u1, v0, v1 = face.ParameterRange
        best: tuple[float, Any] | None = None
        for i in range(6):
            for j in range(6):
                point = face.valueAt(u0 + (u1 - u0) * (i + 0.5) / 6, v0 + (v1 - v0) * (j + 0.5) / 6)
                if face.isInside(point, 1e-6, True):
                    distance = (point - centre).Length
                    if best is None or distance < best[0]:
                        best = (distance, point)
        if best is not None:
            return best[1]
    except Exception:
        pass
    return centre


# ---------------------------------------------------------------- edges

def _edge_name(shape: Any, edge: Any) -> str | None:
    for position, other in enumerate(shape.Edges, 1):
        if other.isSame(edge):
            return f"Edge{position}"
    return None


def _profile_plane(feature: Any) -> tuple[Any, Any]:
    profile = getattr(feature, "Profile", None)
    sketch = profile[0] if isinstance(profile, tuple) else profile
    if sketch is not None and sketch.TypeId == "Sketcher::SketchObject":
        return sketch_plane_info(sketch)
    return App.Vector(), App.Vector(0, 0, 1)


def _edge_roles(result: BodyRoles, features: dict[str, Any]) -> None:
    shape = result.shape
    tol = _tolerance(shape)
    for key, role_faces in list(result.faces.items()):
        path, _, role = key.rpartition("/")
        base = role_base(role)
        if base == "top":
            for entry in role_faces:
                names = [n for n in (_edge_name(shape, e) for e in entry.face.OuterWire.Edges) if n]
                if names:
                    result.edges.setdefault(f"{path}/top_outer", []).extend(names)
        elif base in {"wall", "counterbore_wall"} and "@" not in role and path in features:
            origin, normal = _profile_plane(features[path])
            names = _entry_rim_edges(shape, [entry.face for entry in role_faces], origin, normal, tol)
            if names:
                rim_role = "rim" if base == "wall" else "counterbore_rim"
                known = result.edges.setdefault(f"{path}/{rim_role}", [])
                known.extend(name for name in names if name not in known)


def _entry_rim_edges(shape: Any, walls: list[Any], origin: Any, normal: Any, tol: float) -> list[str]:
    """Edges where the walls meet a face parallel to the sketch plane, on the side the cut opens.

    A hole or pocket is sketched on a face and cuts away from it, so the opening
    is the part of the wall nearest to the sketch plane's side.
    """
    openings: list[tuple[float, str]] = []
    # The planes parallel to the sketch, with their edges, are found once: asking a face for
    # its edges builds them again every time, and this loop ran it for every wall edge.
    planes = [(other, other.Edges) for other in shape.Faces if isinstance(other.Surface, Part.Plane) and _parallel(other.Surface.Axis, normal)]
    for wall in walls:
        for edge in wall.Edges:
            for other, other_edges in planes:
                if other.isSame(wall):
                    continue
                if any(edge.isSame(shared) for shared in other_edges):
                    name = _edge_name(shape, edge)
                    if name:
                        openings.append(((edge.CenterOfMass - origin).dot(normal), name))
    if not openings:
        return []
    nearest = max(position for position, _name in openings)
    out: list[str] = []
    for position, name in openings:
        if abs(position - nearest) <= tol * 10 and name not in out:
            out.append(name)
    return out


# ---------------------------------------------------------------- resolution (used by ops)

def _matching_keys(roles: BodyRoles, feature_path: str, role: str | None) -> list[str]:
    prefix = f"{feature_path}/"
    keys = [key for key in list(roles.faces) + list(roles.edges) if key.startswith(prefix)]
    if role is None:
        return keys
    return [key for key in keys if role_matches(key, f"{feature_path}/{role}")]


def role_matches(key: str, wanted: str) -> bool:
    """``wall`` is exactly that role (the first instance of a pattern); ``side`` also
    covers ``side.0``, ``side.1``... and the pieces ``side.0~0``, ``side.0~1``; ``wall@*`` covers every instance of a pattern."""
    if wanted.endswith("@*"):
        base = wanted[:-2]
        return key == base or key.startswith(base + "@") or key.startswith(base + PIECE_SEPARATOR)
    return key == wanted or key.startswith(wanted + ".") or key.startswith(wanted + PIECE_SEPARATOR)


def known_role_paths(ctx: Any) -> list[str]:
    from .assembly import units

    paths: list[str] = []
    for unit in units(ctx.session):
        roles = unit.roles(ctx.session)
        if roles is not None:
            paths.extend(roles.faces)
            paths.extend(roles.edges)
    return paths


def _body_for_feature(ctx: Any, feature_path: str) -> Any:
    from .assembly import units

    for unit in units(ctx.session):
        if unit.kind != "body" and (feature_path == unit.path or feature_path.startswith(unit.path + "/")):
            raise ReifyOpError(
                "OP_SCHEMA_INVALID",
                f"'{feature_path}' belongs to the {unit.kind} '{unit.path}'; features of a linked part change in the part's own document",
                detail={"path": "feature", "reason": f"{unit.kind} features are read-only here", "source": unit.source_path},
                hints=[f"edit {unit.source_path} with cad.part.open, then apply again here" if unit.source_path else "edit the source document"],
            )
    obj = ctx.lookup(feature_path)
    owner = owning_body(obj)
    if owner is None:
        raise ReifyOpError("TARGET_NOT_FOUND", f"'{feature_path}' is not a feature of a body", target=feature_path)
    return owner


def _face_candidates(ctx: Any, selector: dict[str, Any]) -> list[tuple[Any, RoleFace, str]]:
    if "between" in selector:
        raise ReifyOpError("OP_SCHEMA_INVALID", "'between' selects edges, not faces", detail={"reason": "between is an edge selector"})
    feature_path = selector["feature"]
    body = _body_for_feature(ctx, feature_path)
    roles = ctx.session.roles(body)
    keys = [key for key in _matching_keys(roles, feature_path, selector.get("role")) if key in roles.faces]
    return [(body, entry, key) for key in keys for entry in roles.faces[key]]


def resolve_faces(ctx: Any, selector: dict[str, Any]) -> list[tuple[Any, str, Any]]:
    """[(body, face name in the body's shape, face)] for a ``{feature, role}`` selector."""
    found = _face_candidates(ctx, selector)
    if not found:
        known = [p for p in known_role_paths(ctx) if p.startswith(selector["feature"] + "/")]
        raise ReifyOpError(
            "TARGET_NOT_FOUND",
            f"no face for {selector}",
            target=f"{selector['feature']}/{selector.get('role', '')}".rstrip("/"),
            detail={"target": selector, "known": similar_paths(f"{selector['feature']}/{selector.get('role', '')}", known or known_role_paths(ctx))},
        )
    return [(body, entry.face_name, entry.face) for body, entry, _key in found]


def resolve_single_face(ctx: Any, selector: dict[str, Any]) -> tuple[Any, str]:
    found = resolve_faces(ctx, selector)
    if len(found) > 1:
        raise ReifyOpError(
            "TARGET_AMBIGUOUS",
            f"{selector} matches {len(found)} faces",
            target=selector["feature"],
            detail={"candidates": [{"face": name, "center": [round(c, 3) for c in face.CenterOfMass]} for _b, name, face in found[:10]]},
            hints=["add a role (for example side.0) or use between"],
        )
    body, name, _face = found[0]
    tip = body.Tip if body.Tip is not None else None
    return (tip if tip is not None else body), name


def resolve_edges(ctx: Any, selectors: list[dict[str, Any]]) -> tuple[Any, list[str]]:
    """(body, Edge names in the body's current shape) for fillet / chamfer selectors."""
    body_found: Any = None
    names: list[str] = []
    for selector in selectors:
        body, edge_names = _edges_for(ctx, selector)
        if body_found is not None and body is not body_found:
            raise ReifyOpError("OP_SCHEMA_INVALID", "edges of one op must belong to one body", detail={"reason": "mixed bodies"})
        body_found = body
        names.extend(n for n in edge_names if n not in names)
    return body_found, names


def _edge_facts(shape: Any, name: str) -> dict[str, Any]:
    edge = shape.Edges[int(name[4:]) - 1]
    curve = edge.Curve
    fact: dict[str, Any] = {"edge": name, "length": round(edge.Length, 4), "center": [round(c, 3) for c in edge.CenterOfMass]}
    if isinstance(curve, Part.Circle):
        fact["radius"] = round(float(curve.Radius), 4)
        fact["_axis"], fact["_centre"] = curve.Axis, curve.Center
    return fact


def _concentric_radii(facts: list[dict[str, Any]]) -> bool:
    """True when two circular edges share an axis and differ in radius: an inner and an outer edge."""
    circles = [f for f in facts if "radius" in f]
    for i, a in enumerate(circles):
        for b in circles[i + 1:]:
            if abs(a["radius"] - b["radius"]) < 1e-4 or not _parallel(a["_axis"], b["_axis"]):
                continue
            offset = b["_centre"] - a["_centre"]
            if (offset - a["_axis"] * offset.dot(a["_axis"])).Length <= 1e-4 * max(1.0, a["radius"]):
                return True
    return False


def _public(fact: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in fact.items() if not key.startswith("_")}


def _filter_circular(shape: Any, names: list[str], selector: dict[str, Any]) -> list[str]:
    """Apply ``which`` and ``radius`` to the circular edges of ``names``; an unfiltered ring is ambiguous."""
    which, wanted = selector.get("which"), selector.get("radius")
    facts = [_edge_facts(shape, name) for name in names]
    if which is None and wanted is None:
        if _concentric_radii(facts):
            radii = sorted({f["radius"] for f in facts if "radius" in f})
            raise ReifyOpError(
                "TARGET_AMBIGUOUS", f"{selector} matches concentric circular edges of {len(radii)} radii ({', '.join(str(r) for r in radii)} mm)",
                target=selector.get("feature"),
                detail={"candidates": [_public(f) for f in facts[:12]], "which": ["outer", "inner", "all"], "radii": radii},
                hints=[f'add "which": "outer" (radius {radii[-1]}) or "inner" (radius {radii[0]}), or "which": "all" for every edge',
                       'or filter with "radius": {"min": ..., "max": ...}'],
            )
        return names
    keep = facts
    if wanted is not None:
        low, high = wanted.get("min", -math.inf) - 1e-4, wanted.get("max", math.inf) + 1e-4
        keep = [f for f in keep if "radius" in f and low <= f["radius"] <= high]
    if which in ("outer", "inner"):
        circles = [f for f in keep if "radius" in f]
        if circles:
            pick = max(f["radius"] for f in circles) if which == "outer" else min(f["radius"] for f in circles)
            keep = [f for f in keep if "radius" not in f or abs(f["radius"] - pick) < 1e-4]
    if not keep:
        raise ReifyOpError(
            "TARGET_NOT_FOUND", f"no circular edge of {selector} satisfies which/radius", target=selector.get("feature"),
            detail={"target": selector, "candidates": [_public(f) for f in facts[:12]], "which": ["outer", "inner", "all"]},
            hints=["list the candidates' radius and choose a which or radius range that matches one of them"],
        )
    return [f["edge"] for f in keep]


def _edges_for(ctx: Any, selector: dict[str, Any]) -> tuple[Any, list[str]]:
    body, names = _edges_unfiltered(ctx, selector)
    return body, _filter_circular(ctx.session.roles(body).shape, names, selector)


def _edges_unfiltered(ctx: Any, selector: dict[str, Any]) -> tuple[Any, list[str]]:
    if "between" in selector:
        first, second = selector["between"]
        faces_a = _face_candidates(ctx, first)
        faces_b = _face_candidates(ctx, second)
        if not faces_a or not faces_b:
            missing = first if not faces_a else second
            raise ReifyOpError("TARGET_NOT_FOUND", f"no face for {missing}", target=missing.get("feature"),
                               detail={"target": missing, "known": similar_paths(missing.get("feature", ""), known_role_paths(ctx))})
        body = faces_a[0][0]
        shape = ctx.session.roles(body).shape
        names: list[str] = []
        for _b, entry_a, _k in faces_a:
            for _b2, entry_b, _k2 in faces_b:
                for edge in entry_a.face.Edges:
                    if any(edge.isSame(other) for other in entry_b.face.Edges):
                        name = _edge_name(shape, edge)
                        if name and name not in names:
                            names.append(name)
        if not names:
            raise ReifyOpError("TARGET_NOT_FOUND", "the two faces share no edge", target=first.get("feature"), detail={"target": selector, "known": []})
        return body, names
    feature_path = selector["feature"]
    body = _body_for_feature(ctx, feature_path)
    roles = ctx.session.roles(body)
    keys = [key for key in _matching_keys(roles, feature_path, selector.get("role")) if key in roles.edges]
    names = [name for key in keys for name in roles.edges[key]]
    if not names:
        raise ReifyOpError(
            "TARGET_NOT_FOUND", f"no edge for {selector}", target=f"{feature_path}/{selector.get('role', '')}".rstrip("/"),
            detail={"target": selector, "known": similar_paths(f"{feature_path}/{selector.get('role', '')}", list(roles.edges))},
        )
    return body, names
