"""Small FreeCAD helpers shared by the ops (imports FreeCAD)."""

from __future__ import annotations

import difflib
from typing import Any, Iterable

import FreeCAD as App

PATH_PROPERTY = "ReifyPath"
PATH_GROUP = "Reify"
PARAMS_NAME = "Params"
REQUIREMENTS_NAME = "Requirements"


def set_path(obj: Any, path: str) -> None:
    if PATH_PROPERTY not in obj.PropertiesList:
        obj.addProperty("App::PropertyString", PATH_PROPERTY, PATH_GROUP, "Semantic path (Pi-CAD)")
    setattr(obj, PATH_PROPERTY, path)
    # Bodies and occurrences become STEP products; their label is the full path so every
    # occurrence name in the exported assembly is unique.
    obj.Label = path if obj.TypeId in {"PartDesign::Body", "App::Part"} else path.split("/")[-1]
    if obj.TypeId == "App::Part":  # the shape inside an occurrence is the STEP product that carries the name
        for child in obj.Group:
            if child.TypeId == "Part::Feature":
                child.Label = path


def get_path(obj: Any) -> str | None:
    if PATH_PROPERTY in obj.PropertiesList:
        value = getattr(obj, PATH_PROPERTY)
        return value or None
    return None


def path_index(doc: Any) -> dict[str, Any]:
    """Semantic path -> document object, for every object that carries one."""
    index: dict[str, Any] = {}
    for obj in doc.Objects:
        path = get_path(obj)
        if path:
            index[path] = obj
    return index


def is_body(obj: Any) -> bool:
    return obj.TypeId == "PartDesign::Body"


def is_sketch(obj: Any) -> bool:
    return obj.TypeId == "Sketcher::SketchObject"


def is_feature(obj: Any) -> bool:
    """A solid-producing PartDesign feature (not a sketch, datum, or body)."""
    return obj.isDerivedFrom("PartDesign::Feature") and not obj.isDerivedFrom("PartDesign::Body")


def bodies(doc: Any) -> list[Any]:
    return [obj for obj in doc.Objects if is_body(obj)]


def body_features(body: Any) -> list[Any]:
    return [obj for obj in body.Group if is_feature(obj)]


def body_sketches(body: Any) -> list[Any]:
    return [obj for obj in body.Group if is_sketch(obj)]


def owning_body(obj: Any) -> Any | None:
    try:
        parent = obj.getParentGeoFeatureGroup()
    except Exception:
        return None
    return parent if parent is not None and is_body(parent) else None


def origin_feature(body: Any, role: str) -> Any:
    for feature in body.Origin.OriginFeatures:
        if feature.Role == role:
            return feature
    raise KeyError(role)


def similar_paths(path: str, known: Iterable[str], limit: int = 20) -> list[str]:
    known_list = sorted(known)
    close = difflib.get_close_matches(path, known_list, n=limit, cutoff=0.3)
    return close or known_list[:limit]


def vector(values: Iterable[float]) -> Any:
    x, y, z = values
    return App.Vector(float(x), float(y), float(z))


JOINTS_NAME = "Joints"
KIND_PROPERTY = "OccurrenceKind"
