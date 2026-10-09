"""The ``dfm_profile`` op: which rulepack and material a document is checked against (imports FreeCAD for the handler).

Stored as one ``App::VarSet`` named ``DfmProfile`` with string properties ``Rulepack``,
``Material`` and ``Overrides`` (JSON). The object exists only when a profile is set.
"""

from __future__ import annotations

import json
from typing import Any

from ..errors import ReifyOpError
from .rulepack import load_rulepack

PROFILE_NAME = "DfmProfile"
_GROUP = "DfmProfile"


def get_profile(session: Any) -> dict[str, Any] | None:
    """``{"rulepack", "material", "overrides"}`` of the document, or None when no profile is set."""
    obj = session.doc.getObject(PROFILE_NAME)
    if obj is None:
        return None
    try:
        overrides = json.loads(obj.Overrides or "{}")
    except ValueError:
        overrides = {}
    return {"rulepack": obj.Rulepack, "material": obj.Material or None, "overrides": overrides}


def dfm_profile(ctx: Any, op: dict[str, Any]) -> None:
    doc = ctx.doc
    existing = doc.getObject(PROFILE_NAME)
    rulepack_id = op["rulepack"]
    if rulepack_id is None:
        if existing is not None:
            doc.removeObject(existing.Name)
        return
    pack = load_rulepack(rulepack_id)
    material = op.get("material")
    if material not in pack.materials:
        raise ReifyOpError(
            "DFM_MATERIAL_UNKNOWN", f"unknown material {material!r} for rulepack {pack.id}", target=str(material),
            detail={"target": str(material), "known": sorted(pack.materials)},
            hints=[f"use one of: {', '.join(sorted(pack.materials))}"],
        )
    if existing is None:
        existing = doc.addObject("App::VarSet", PROFILE_NAME)
        for name in ("Rulepack", "Material", "Overrides"):
            existing.addProperty("App::PropertyString", name, _GROUP)
        existing.Overrides = "{}"
    existing.Rulepack = pack.id
    existing.Material = material
