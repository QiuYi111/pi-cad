"""Assemblies: linked parts, imported STEP references, joints (imports FreeCAD).

One part is one document and one assembly is one document. A ``link`` op adds an
*occurrence* of a body of another ``.FCStd`` file; ``import_step`` adds a bought-in
STEP as a reference. Both are an ``App::Part`` container (its Placement is the
pose) that holds a ``Part::Feature`` with the shape. FreeCAD's cross-document
``App::Link`` is not used: it dangles whenever the part document is reloaded
(rollback, undo, a change from another process), while a shape copy that the
assembly refreshes from the part's saved file cannot.

Every consumer (queries, joints, export) works on *units*: a body of this
document, an occurrence, or a reference. A unit's roles are keyed by assembly
paths, so ``arm/forearm/j3_bearing_seat/wall`` names a face of the forearm part
whatever the part's own body is called.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import FreeCAD as App
import Part

from .core import JOINTS_NAME, KIND_PROPERTY, bodies, body_features, get_path
from .errors import ReifyOpError
from .roles import BodyRoles

OCCURRENCE = "occurrence"
REFERENCE = "reference"
BODY = "body"
_GROUP = "Reify"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rekey_path(source_body: str | None, unit_path: str, path: str) -> str:
    """``forearm/j3/wall`` of a part whose body is ``forearm`` -> ``arm/forearm/j3/wall``."""
    if source_body and (path == source_body or path.startswith(source_body + "/")):
        return unit_path + path[len(source_body):]
    return f"{unit_path}/{path}"


@dataclass
class Unit:
    """Something with a pose and a shape: a body, an occurrence of a linked part, or a reference."""

    path: str
    kind: str
    obj: Any
    #: Session that owns the features and roles (this one for bodies, the part's for occurrences).
    owner: Any
    #: The body whose features this unit shows; None for references.
    body: Any | None
    source_path: str | None = None

    @property
    def placement(self) -> Any:
        return self.obj.Placement

    def local_shape(self) -> Any:
        if self.kind == BODY:
            shape = self.obj.Shape.copy()
            shape.Placement = App.Placement()
            return shape
        leaf = self.leaf()
        return leaf.Shape if leaf is not None else Part.Shape()

    def leaf(self) -> Any | None:
        for child in self.obj.Group:
            if child.TypeId == "Part::Feature":
                return child
        return None

    def shape(self) -> Any:
        """World shape; a body's single solid is unwrapped from FreeCAD's compound."""
        if self.kind == BODY:
            shape = self.obj.Shape
        else:
            shape = self.local_shape().copy()
            shape.Placement = self.obj.Placement.multiply(shape.Placement)
        if shape.isNull():
            return shape
        if shape.ShapeType == "Compound" and len(shape.Solids) == 1:
            return shape.Solids[0]
        return shape

    def solid_count(self) -> int:
        shape = self.shape()
        return 0 if shape.isNull() else len(shape.Solids)

    def roles(self, session: Any) -> BodyRoles | None:
        if self.kind == REFERENCE or self.body is None:
            return None
        if self.kind == BODY:
            return session.roles(self.body)
        if self.owner is None or self.body is None:
            return None
        # Roles are those of the part revision the occurrence's shape was taken from, not of
        # a newer revision the part has since been given: the cache is replaced on refresh.
        cached = session.occurrence_roles.get(self.obj.Name)
        if cached is not None and cached[0] == self.obj.SourceSha256:
            base = cached[1]
        else:
            base = self.owner.roles(self.body)
            session.occurrence_roles[self.obj.Name] = (self.obj.SourceSha256, base)
        source_body = get_path(self.body) or ""
        rekeyed = BodyRoles(body=self.obj, shape=base.shape, placement=self.obj.Placement)
        rekeyed.faces = {rekey_path(source_body, self.path, key): list(value) for key, value in base.faces.items()}
        rekeyed.edges = {rekey_path(source_body, self.path, key): list(value) for key, value in base.edges.items()}
        return rekeyed

    def features(self) -> list[tuple[str, Any]]:
        """(path in this assembly, feature object) for every feature of the unit."""
        if self.body is None:
            return []
        source_body = get_path(self.body) or ""
        out = []
        for feature in body_features(self.body):
            path = get_path(feature)
            if path:
                out.append((path if self.kind == BODY else rekey_path(source_body, self.path, path), feature))
        return out


def is_unit_container(obj: Any) -> bool:
    return obj.TypeId == "App::Part" and KIND_PROPERTY in obj.PropertiesList


def units(session: Any) -> list[Unit]:
    """Every body, occurrence and reference of the document, sorted by path."""
    found: list[Unit] = []
    for body in bodies(session.doc):
        path = get_path(body)
        if path:
            found.append(Unit(path, BODY, body, session, body))
    for obj in session.doc.Objects:
        if not is_unit_container(obj) or not get_path(obj):
            continue
        kind = getattr(obj, KIND_PROPERTY)
        if kind == OCCURRENCE:
            absolute = session.resolve_project_path(obj.LinkPart)
            source = session.registry.get(absolute) if absolute.exists() else None
            body = _find_body(source, obj.LinkBody)
            found.append(Unit(get_path(obj), OCCURRENCE, obj, source, body, obj.LinkPart))
        else:
            found.append(Unit(get_path(obj), REFERENCE, obj, session, None, getattr(obj, "LinkFile", None)))
    return sorted(found, key=lambda unit: unit.path)


def unit_by_path(session: Any, path: str) -> Unit | None:
    return next((unit for unit in units(session) if unit.path == path), None)


def _find_body(session: Any, body_path: str) -> Any | None:
    if session is None:
        return None
    return next((b for b in bodies(session.doc) if get_path(b) == body_path), None)


# ---------------------------------------------------------------- creating containers

def _add_prop(obj: Any, kind: str, name: str, value: Any) -> None:
    obj.addProperty(kind, name, _GROUP)
    setattr(obj, name, value)


def make_container(ctx: Any, path: str, kind: str, shape: Any) -> Any:
    doc = ctx.doc
    container = doc.addObject("App::Part", "Occurrence")
    leaf = doc.addObject("Part::Feature", "OccurrenceShape")
    leaf.Shape = shape
    container.addObject(leaf)
    ctx.register(container, path)
    leaf.Label = path
    _add_prop(container, "App::PropertyString", KIND_PROPERTY, kind)
    return container


def occurrence_shape(source: Any, body: Any) -> Any:
    shape = body.Shape.copy()
    shape.Placement = App.Placement()
    return shape


def open_source(ctx: Any, part: str, body_path: str) -> tuple[Any, Any]:
    """(source session, body) for a ``link``; errors name what exists."""
    absolute = ctx.session.resolve_project_path(part)
    if absolute == ctx.session.fcstd:
        raise ReifyOpError("OP_SCHEMA_INVALID", "a document cannot link to itself", detail={"path": "part", "reason": "self link"})
    if not absolute.exists():
        raise ReifyOpError("TARGET_NOT_FOUND", f"part document {part} does not exist", target=part,
                           detail={"target": part, "known": []}, hints=["build the part first: cad.part.open(path, create=True)"])
    source = ctx.session.registry.source(absolute)
    body = _find_body(source, body_path)
    if body is None:
        known = [get_path(b) for b in bodies(source.doc) if get_path(b)]
        raise ReifyOpError("TARGET_NOT_FOUND", f"{part} has no body '{body_path}'", target=body_path,
                           detail={"target": body_path, "known": known})
    return source, body


def link(ctx: Any, op: dict[str, Any]) -> None:
    source, body = open_source(ctx, op["part"], op["body"])
    container = make_container(ctx, op["name"], OCCURRENCE, occurrence_shape(source, body))
    _add_prop(container, "App::PropertyString", "LinkPart", op["part"])
    _add_prop(container, "App::PropertyString", "LinkBody", op["body"])
    _add_prop(container, "App::PropertyString", "SourceSha256", file_sha256(source.fcstd))
    if "position" in op or "rotation" in op:
        from .ops.placement import set_pose

        set_pose(ctx, container, op)


def import_step(ctx: Any, op: dict[str, Any]) -> None:
    absolute = ctx.session.resolve_project_path(op["file"])
    if not absolute.exists():
        raise ReifyOpError("TARGET_NOT_FOUND", f"STEP file {op['file']} does not exist", target=op["file"],
                           detail={"target": op["file"], "known": []})
    shape = Part.Shape()
    shape.read(str(absolute))
    if shape.isNull() or not shape.Faces:
        raise ReifyOpError("FEATURE_FAILED", f"{op['file']} contains no geometry", target=op["name"],
                           detail={"feature": op["name"], "freecadStatus": "empty STEP"})
    if not shape.Solids:
        ctx.warnings.append({
            "code": "REFERENCE_SURFACES_ONLY", "target": op["name"],
            "detail": {"faces": len(shape.Faces), "note": "the STEP has surfaces and no solid; it is a visual reference and takes no part in solid checks"},
        })
    container = make_container(ctx, op["name"], REFERENCE, shape)
    _add_prop(container, "App::PropertyString", "LinkFile", op["file"])
    _add_prop(container, "App::PropertyString", "FileSha256", file_sha256(absolute))
    _add_prop(container, "App::PropertyString", "Role", "bought_in")
    if "position" in op or "rotation" in op:
        from .ops.placement import set_pose

        set_pose(ctx, container, op)


# ---------------------------------------------------------------- refreshing from the part files

def refresh_links(session: Any) -> list[str]:
    """Bring occurrences and references up to date with their files; returns the paths that changed.

    A part document that gained a revision (from this worker or from another
    process) is reloaded, and the occurrence takes the new shape. Poses and joints
    stay as they are.
    """
    changed: list[str] = []
    for obj in session.doc.Objects:
        if not is_unit_container(obj) or not get_path(obj):
            continue
        path = get_path(obj)
        kind = getattr(obj, KIND_PROPERTY)
        leaf = next((c for c in obj.Group if c.TypeId == "Part::Feature"), None)
        if leaf is None:
            continue
        if kind == OCCURRENCE:
            absolute = session.resolve_project_path(obj.LinkPart)
            if not absolute.exists():
                continue
            source = session.registry.source(absolute)
            digest = file_sha256(source.fcstd)
            body = _find_body(source, obj.LinkBody)
            if digest != obj.SourceSha256 and body is not None:
                leaf.Shape = occurrence_shape(source, body)
                obj.SourceSha256 = digest
                session.occurrence_roles.pop(obj.Name, None)
                changed.append(path)
        elif kind == REFERENCE:
            absolute = session.resolve_project_path(obj.LinkFile)
            if not absolute.exists():
                continue
            digest = file_sha256(absolute)
            if digest != obj.FileSha256:
                shape = Part.Shape()
                shape.read(str(absolute))
                leaf.Shape = shape
                obj.FileSha256 = digest
                changed.append(path)
    return changed


# ---------------------------------------------------------------- joints

def joints_group(session: Any, create: bool) -> Any | None:
    group = session.doc.getObject(JOINTS_NAME)
    if group is None and create:
        group = session.doc.addObject("App::DocumentObjectGroup", JOINTS_NAME)
    return group


def joint_objects(session: Any) -> list[Any]:
    group = joints_group(session, create=False)
    return list(group.Group) if group is not None else []


def face_frame(face: Any) -> Any:
    """Placement whose z axis is the cylinder or cone axis, or the plane normal, at a point of the feature."""
    surface = face.Surface
    if isinstance(surface, Part.Plane):
        centre = face.CenterOfMass
        u, v = surface.parameter(centre)
        z = face.normalAt(u, v)
        origin = centre
    elif isinstance(surface, Part.Cylinder):
        origin, z = surface.Center, surface.Axis
    elif isinstance(surface, Part.Cone):
        origin, z = surface.Apex, surface.Axis
    else:
        raise ReifyOpError("OP_SCHEMA_INVALID", "a joint frame needs a plane, cylinder or cone role", detail={"path": "parent", "reason": f"{type(surface).__name__} has no axis"})
    return App.Placement(origin, App.Rotation(App.Vector(0, 0, 1), z))


def find_role_face(session: Any, selector: dict[str, Any]) -> tuple[Unit, Any]:
    """The one face a ``{feature, role}`` selector names, with the unit that owns it."""
    wanted = f"{selector['feature']}/{selector['role']}" if selector.get("role") else selector["feature"]
    hits: list[tuple[Unit, Any]] = []
    from .roles import role_matches

    for unit in units(session):
        roles = unit.roles(session)
        if roles is None:
            continue
        for key, entries in roles.faces.items():
            if role_matches(key, wanted):
                hits.extend((unit, entry.face) for entry in entries)
    if not hits:
        known = [key for unit in units(session) for key in (unit.roles(session).faces if unit.roles(session) else [])]
        from .core import similar_paths

        raise ReifyOpError("TARGET_NOT_FOUND", f"no face for {selector}", target=wanted, detail={"target": selector, "known": similar_paths(wanted, known)})
    if len(hits) > 1:
        raise ReifyOpError("TARGET_AMBIGUOUS", f"{selector} matches {len(hits)} faces; a joint frame needs one", target=wanted,
                           detail={"candidates": [{"unit": u.path, "center": [round(c, 3) for c in f.CenterOfMass]} for u, f in hits[:10]]},
                           hints=["name one instance, for example wall@2"])
    return hits[0]


def joint(ctx: Any, op: dict[str, Any]) -> None:
    session = ctx.session
    parent_unit, parent_face = find_role_face(session, op["parent"])
    child_unit, child_face = find_role_face(session, op["child"])
    if child_unit.kind == REFERENCE or child_unit.obj is None:
        raise ReifyOpError("OP_SCHEMA_INVALID", "the child of a joint must be a body or an occurrence", detail={"path": "child", "reason": "reference"})
    if parent_unit.path == child_unit.path:
        raise ReifyOpError("OP_SCHEMA_INVALID", "parent and child are the same part", detail={"path": "child", "reason": "same unit"})
    kind = op["type"]
    group = joints_group(session, create=True)
    item = ctx.doc.addObject("App::VarSet", "Joint")
    group.addObject(item)
    ctx.register(item, op["name"])
    item.addProperty("App::PropertyString", "JointType", _GROUP)
    item.addProperty("App::PropertyString", "Parent", _GROUP)
    item.addProperty("App::PropertyString", "Child", _GROUP)
    item.addProperty("App::PropertyString", "Limits", _GROUP)
    item.addProperty("App::PropertyBool", "Flip", _GROUP)
    value_type = {"revolute": "App::PropertyAngle", "prismatic": "App::PropertyLength"}.get(kind)
    if value_type:
        item.addProperty(value_type, "Value", _GROUP)
    item.JointType = kind
    item.Parent = json.dumps({**op["parent"], "unit": parent_unit.path})
    item.Child = json.dumps({**op["child"], "unit": child_unit.path})
    item.Limits = json.dumps(op.get("limits") or [])
    item.Flip = bool(op.get("flip", False))
    if value_type:
        ctx.set_value(item, "Value", op.get("value", 0))
    elif "value" in op:
        raise ReifyOpError("OP_SCHEMA_INVALID", "a fixed joint has no value", detail={"path": "value", "reason": "fixed"})
    if op.get("limits"):
        lo, hi = op["limits"]
        if lo > hi:
            raise ReifyOpError("OP_SCHEMA_INVALID", "limits must be [low, high]", detail={"path": "limits", "reason": "low above high"})
    apply_joints(session)


def apply_joints(session: Any) -> bool:
    """Set the pose of every joint's child from its current value; True when a pose changed."""
    changed = False
    for item in joint_objects(session):
        parent = json.loads(item.Parent)
        child = json.loads(item.Child)
        try:
            parent_unit, parent_face = find_role_face(session, {k: parent[k] for k in ("feature", "role") if k in parent})
            child_unit, child_face = find_role_face(session, {k: child[k] for k in ("feature", "role") if k in child})
        except ReifyOpError:
            continue  # a dangling joint is reported by the requirement check, not here
        parent_roles = parent_unit.roles(session)
        frame_parent = parent_roles.placement.multiply(face_frame(parent_face))
        frame_child = face_frame(child_face)
        kind = item.JointType
        value = float(item.Value.Value) if "Value" in item.PropertiesList else 0.0
        if kind == "revolute":
            motion = App.Placement(App.Vector(), App.Rotation(App.Vector(0, 0, 1), value))
        elif kind == "prismatic":
            motion = App.Placement(App.Vector(0, 0, value), App.Rotation())
        else:
            motion = App.Placement()
        if item.Flip:
            motion = motion.multiply(App.Placement(App.Vector(), App.Rotation(App.Vector(1, 0, 0), 180)))
        pose = frame_parent.multiply(motion).multiply(frame_child.inverse())
        target = child_unit.obj
        if not _same_placement(target.Placement, pose):
            target.Placement = pose
            changed = True
    return changed


def _same_placement(a: Any, b: Any) -> bool:
    return (a.Base - b.Base).Length < 1e-9 and a.Rotation.isSame(b.Rotation, 1e-12)


def joint_status(session: Any) -> list[dict[str, Any]]:
    """Joint values and limit results; a value outside its limits is a failed requirement."""
    out = []
    for item in joint_objects(session):
        limits = json.loads(item.Limits)
        value = round(float(item.Value.Value), 6) if "Value" in item.PropertiesList else None
        entry: dict[str, Any] = {"path": get_path(item), "kind": "joint_limits" if limits else "joint", "joint": item.JointType, "value": value}
        if limits and value is not None:
            entry["limit"] = limits
            entry["status"] = "pass" if limits[0] - 1e-9 <= value <= limits[1] + 1e-9 else "fail"
        out.append(entry)
    return [entry for entry in out if "status" in entry]
