"""Detects features that recompute fine but change nothing (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

from .core import get_path
from .errors import ReifyOpError

ADDITIVE = {"pad"}
SUBTRACTIVE = {"pocket", "hole"}
PATTERNS = {"linear_pattern", "polar_pattern", "mirror"}
_BASE_OBJECT_TYPES = {
    "PartDesign::Pad", "PartDesign::Pocket", "PartDesign::Hole",
    "PartDesign::LinearPattern", "PartDesign::PolarPattern", "PartDesign::Mirrored",
}


def _volume(obj: Any) -> float | None:
    shape = getattr(obj, "Shape", None)
    if shape is None or shape.isNull() or not shape.Solids:
        return None
    return float(sum(solid.Volume for solid in shape.Solids))


def check_feature_effect(ctx: Any, op: dict[str, Any]) -> None:
    """Fail when a pad, pocket, hole or pattern did not change the solid's volume.

    The first feature of a body has no base to compare with, so it never counts as no effect.
    """
    kind = op.get("op")
    if kind not in ADDITIVE | SUBTRACTIVE | PATTERNS:
        return
    path = op["name"]
    obj = ctx.index().get(path)
    if obj is None or obj.TypeId not in _BASE_OBJECT_TYPES:
        return
    base = getattr(obj, "BaseFeature", None)
    if base is None:
        return
    before, after = _volume(base), _volume(obj)
    if before is None or after is None:
        return
    delta = after - before
    threshold = max(1e-6 * max(before, after), 1e-9)
    if kind in ADDITIVE:
        effective, expected = delta > threshold, "added"
    elif kind in SUBTRACTIVE:
        effective, expected = -delta > threshold, "removed"
    else:
        effective, expected = abs(delta) > threshold, "changed"
    if effective:
        return
    detail: dict[str, Any] = {"feature": path, "volumeBefore": round(before, 6), "volumeAfter": round(after, 6), "expected": expected}
    if kind in PATTERNS:
        detail["direction"] = "the pattern copies lie outside the solid or on top of their originals"
        hints = ["the copies must overlap the base solid", "check the count and length, or the direction sign (a leading '-' on the axis)"]
    else:
        detail["direction"] = {
            "pad": "the pad does not add material: the sketch lies inside the solid, or it pushes into material that is already there",
            "pocket": "the pocket cuts away from the material: the sketch plane is on the outside of the solid",
            "hole": "the hole does not enter the material: the sketch is not on a face of the solid",
        }[kind]
        flip = "reversed=false" if op.get("reversed") else "reversed=true"
        hints = {
            "pad": [f"try {flip}", "the sketch may lie inside the solid or be degenerate (zero area)"],
            "pocket": [f"try {flip}", "the sketch plane is on the opposite side of the material", "check the sketch overlaps the solid and the depth is not zero"],
            "hole": ["the sketch plane is on the opposite side of the material: put the hole sketch on the face it enters from", "check the sketch overlaps the solid"],
        }[kind]
    raise ReifyOpError(
        "FEATURE_NO_EFFECT", f"{get_path(obj) or path} {expected} no volume ({before:.6g} -> {after:.6g} mm3)",
        target=path, detail=detail, hints=hints,
    )
