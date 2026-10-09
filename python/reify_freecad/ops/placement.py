"""``body`` and ``placement`` ops: multi-body documents and poses (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

import FreeCAD as App

from ..assembly import is_unit_container, set_pose
from ..core import is_body
from ..errors import ReifyOpError


def body(ctx: Any, op: dict[str, Any]) -> None:
    created = ctx.doc.addObject("PartDesign::Body", "Body")
    ctx.register(created, op["name"])
    ctx.current_body = created


def placement(ctx: Any, op: dict[str, Any]) -> None:
    obj = ctx.lookup(op["target"])
    if not (is_body(obj) or is_unit_container(obj)):
        raise ReifyOpError("OP_SCHEMA_INVALID", f"'{op['target']}' is not a body or an occurrence; poses are set on those",
                           detail={"path": "target", "reason": "not a body or occurrence"})
    set_pose(ctx, obj, op)
