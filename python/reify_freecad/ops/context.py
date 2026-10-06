"""Execution context shared by op handlers (imports FreeCAD)."""

from __future__ import annotations

from typing import Any

from ..core import bodies, get_path, path_index, set_path, similar_paths
from ..errors import ReifyOpError
from ..exprs import PARAMS_OBJECT, is_expression, rewrite_expression
from ..naming import check_not_role_name


class OpContext:
    def __init__(self, session: Any) -> None:
        self.session = session
        self.doc = session.doc
        self.current_body = session.default_body()

    # ---------------------------------------------------------------- lookup
    @property
    def known_params(self) -> set[str]:
        return self.session.param_names()

    def index(self) -> dict[str, Any]:
        return path_index(self.doc)

    def path_of(self, obj: Any) -> str | None:
        return get_path(obj)

    def lookup(self, path: str, *, field: str = "target") -> Any:
        index = self.index()
        if path not in index:
            raise ReifyOpError(
                "TARGET_NOT_FOUND", f"nothing is named '{path}'", target=path,
                detail={"target": path, "known": similar_paths(path, index)},
            )
        return index[path]

    def register(self, obj: Any, path: str) -> None:
        if path == PARAMS_OBJECT or path in self.index():
            raise ReifyOpError("NAME_CONFLICT", f"'{path}' already exists", target=path, hints=["rename or use set"])
        check_not_role_name(path)
        set_path(obj, path)

    def body_for(self, op: dict[str, Any], *, hint: Any | None = None) -> Any:
        """Body an op builds in: explicit ``body``, the body owning ``hint``, a path prefix, or the current body."""
        from ..core import owning_body

        if "body" in op:
            body = self.lookup(op["body"], field="body")
            if body.TypeId != "PartDesign::Body":
                raise ReifyOpError("OP_SCHEMA_INVALID", f"'{op['body']}' is not a body", detail={"path": "body", "reason": "not a body"})
            return body
        if hint is not None:
            owner = owning_body(hint)
            if owner is not None:
                return owner
        name = op.get("name", "")
        best = None
        for body in bodies(self.doc):
            path = get_path(body)
            if path and name.startswith(path + "/") and (best is None or len(path) > len(get_path(best) or "")):
                best = body
        return best or self.current_body

    # ---------------------------------------------------------------- values
    def set_value(self, obj: Any, prop: str, value: Any) -> None:
        """Number -> property value; ``=expr`` -> expression binding."""
        if is_expression(value):
            obj.setExpression(prop, rewrite_expression(value, self.known_params))
            return
        try:
            obj.setExpression(prop, None)
        except Exception:
            pass
        setattr(obj, prop, float(value))

    def recompute(self) -> None:
        self.session.recompute()
