"""STEP export and semantic declarations for the identity binder (imports FreeCAD)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import FreeCAD as App
import Part

from .assembly import units

_KINDS = {
    "PartDesign::Pad": "pad", "PartDesign::Pocket": "pocket", "PartDesign::Hole": "hole",
    "PartDesign::Fillet": "fillet", "PartDesign::Chamfer": "chamfer",
    "PartDesign::LinearPattern": "linear_pattern", "PartDesign::PolarPattern": "polar_pattern",
    "PartDesign::Mirrored": "mirror",
}
_SURFACE_NAMES = {
    Part.Sphere: "sphere", Part.Toroid: "torus", Part.BSplineSurface: "bspline",
    Part.SurfaceOfRevolution: "revolution", Part.SurfaceOfExtrusion: "extrusion",
}
SELECTOR_TOLERANCE = 1e-4
LOOSE_TOLERANCE = 1e-3


def solid_units(session: Any) -> list[Any]:
    """Units that go into the STEP, sorted by path: those with a solid, and references that are surfaces only."""
    found = []
    for unit in units(session):
        shape = unit.shape()
        if shape.isNull():
            continue
        if shape.Solids or (unit.kind == "reference" and shape.Faces):
            found.append(unit)
    return found


def write_step(session: Any, destination: Path) -> list[Any]:
    """Write the STEP. One body is a plain solid; anything else is a named assembly.

    The assembly goes through FreeCAD's STEP exporter with the document structure:
    every body and occurrence is a product named by its semantic path, with its
    placement, so ``cadctl assembly-tree`` and the render ``focus``/``hide`` refs
    can use the names.
    """
    exported = solid_units(session)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp.step")
    try:
        if len(exported) == 1 and exported[0].kind == "body":
            exported[0].shape().exportStep(str(temporary))
        else:
            _export_named(exported, temporary)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return exported


def _export_named(exported: list[Any], destination: Path) -> None:
    """One product per unit, directly under the root, named by semantic path and placed by its pose.

    The flat layout is the one ``cadctl`` can bind: a nested container would give a
    leaf whose location is relative to its parent, which the identity binder does not
    compose. A scratch document holds the products so the real document is not touched.
    """
    import Import

    scratch = App.newDocument("reify_export")
    try:
        leaves = []
        for unit in exported:
            leaf = scratch.addObject("Part::Feature", "Product")
            leaf.Shape = unit.shape()
            leaf.Label = unit.path
            leaves.append(leaf)
        scratch.recompute()
        Import.export(leaves, str(destination))
    finally:
        App.closeDocument(scratch.Name)


def _unit(v: Any) -> list[float]:
    return [round(v.x, 9), round(v.y, 9), round(v.z, 9)]


def _point(v: Any) -> list[float]:
    return [round(v.x, 6), round(v.y, 6), round(v.z, 6)]


def _normal(face: Any) -> list[float]:
    u, v = face.Surface.parameter(face.CenterOfMass)
    return _unit(face.normalAt(u, v))


def _bbox_center(face: Any) -> list[float]:
    box = face.optimalBoundingBox(True, False)
    return _point(box.Center)


def _same_line(p: Any, d: Any, q: Any, e: Any, tol: float) -> bool:
    if d.cross(e).Length > 1e-6:
        return False
    offset = q - p
    return (offset - d * offset.dot(d)).Length <= tol


def _matches(selector: dict[str, Any], face: Any) -> bool:
    surface = face.Surface
    kind = selector["type"]
    if kind == "plane":
        if not isinstance(surface, Part.Plane):
            return False
        n = _normal(face)
        if sum((a - b) ** 2 for a, b in zip(n, selector["normal"])) > 1e-8:
            return False
        return (face.CenterOfMass - App.Vector(*selector["centroid"])).Length <= selector["tolerance"]
    if kind == "cylinder":
        return (
            isinstance(surface, Part.Cylinder) and abs(surface.Radius - selector["radius"]) <= selector["tolerance"]
            and _same_line(surface.Center, surface.Axis, App.Vector(*selector["axisPoint"]), App.Vector(*selector["axisDirection"]), selector["tolerance"])
        )
    if kind == "cone":
        return isinstance(surface, Part.Cone) and _same_line(surface.Apex, surface.Axis, App.Vector(*selector["axisPoint"]), App.Vector(*selector["axisDirection"]), selector["tolerance"])
    return type(surface) in _SURFACE_NAMES and _SURFACE_NAMES[type(surface)] == kind


def face_selector(face: Any, all_faces: list[Any]) -> dict[str, Any]:
    """A selector the build123d side can evaluate on the re-imported STEP."""
    surface = face.Surface
    tolerance = SELECTOR_TOLERANCE
    if isinstance(surface, Part.Plane):
        selector: dict[str, Any] = {"entity": "face", "type": "plane", "normal": _normal(face), "centroid": _point(face.CenterOfMass)}
    elif isinstance(surface, Part.Cylinder):
        selector = {"entity": "face", "type": "cylinder", "radius": round(surface.Radius, 6), "axisDirection": _unit(surface.Axis), "axisPoint": _point(surface.Center)}
    elif isinstance(surface, Part.Cone):
        selector = {"entity": "face", "type": "cone", "axisDirection": _unit(surface.Axis), "axisPoint": _point(surface.Apex)}
    else:
        selector = {"entity": "face", "type": _SURFACE_NAMES.get(type(surface), "other"), "bboxCenter": _bbox_center(face)}
        tolerance = LOOSE_TOLERANCE
    selector["tolerance"] = tolerance
    if "bboxCenter" not in selector and sum(1 for other in all_faces if _matches(selector, other)) > 1:
        selector["bboxCenter"] = _bbox_center(face)
        selector["tolerance"] = LOOSE_TOLERANCE
    return selector


def build_declarations(session: Any) -> dict[str, Any]:
    exported = solid_units(session)
    entities: list[dict[str, Any]] = []
    cursor = 0  # index of the unit's first solid in the STEP
    for unit in exported:
        solids = unit.solid_count()
        entity: dict[str, Any] = {"call": "instance", "path": unit.path, "label": unit.path.split("/")[-1]}
        if solids == 1:
            entity["solidIndex"] = cursor
        cursor += solids
        if solids != 1 and unit.kind != "reference":
            continue  # the identity binder names one solid per instance
        entities.append(entity)
        roles = unit.roles(session)
        if roles is None:
            continue
        shape_faces = [roles.to_world(face) for face in roles.shape.Faces]
        declared: set[str] = {unit.path}
        for feature_path, feature in unit.features():
            keys = sorted(k for k in roles.faces if k.startswith(feature_path + "/") and "/" not in k[len(feature_path) + 1:])
            record: dict[str, Any] = {
                "call": "feature", "path": feature_path, "owner": unit.path,
                "kind": _KINDS.get(feature.TypeId, "feature"), "label": feature_path.split("/")[-1],
            }
            primary = _primary_role(feature.TypeId)
            primary_faces = [roles.to_world(e.face) for e in roles.faces.get(f"{feature_path}/{primary}", [])] if primary else []
            if len(primary_faces) == 1:
                record["selector"] = face_selector(primary_faces[0], shape_faces)
                record["expect"] = "one"
            entities.append(record)
            declared.add(feature_path)
            for key in keys:
                faces = [roles.to_world(entry.face) for entry in roles.faces[key]]
                targets = [(key, faces[0])] if len(faces) == 1 else [(f"{key}~{i}", face) for i, face in enumerate(faces)]
                for path, face in targets:
                    if path in declared:
                        continue
                    declared.add(path)
                    entities.append({
                        "call": "faces", "path": path, "owner": feature_path,
                        "selector": face_selector(face, shape_faces), "expect": "one",
                    })
    only = exported[0] if len(exported) == 1 else None
    return {"schema": 1, "assembly": only.path if only is not None else None, "entities": entities}


def _primary_role(type_id: str) -> str | None:
    return {"PartDesign::Hole": "wall", "PartDesign::Fillet": "round", "PartDesign::Chamfer": "bevel"}.get(type_id)


def write_declarations(session: Any, step: Path) -> Path:
    destination = step.with_name(step.name + ".declarations.json")
    document = build_declarations(session)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    os.replace(temporary, destination)
    return destination
