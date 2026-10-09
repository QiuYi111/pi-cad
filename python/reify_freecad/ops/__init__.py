"""Op registry: schema (pure) plus handler (imports FreeCAD, resolved lazily)."""

from __future__ import annotations

import importlib
from typing import Any, Callable

from .schema import OP_NAMES, SCHEMAS, validate_op, validate_ops  # noqa: F401

# op -> (module, function)
_HANDLERS: dict[str, tuple[str, str]] = {
    "param": ("params", "param"),
    "body": ("placement", "body"),
    "placement": ("placement", "placement"),
    "sketch": ("features", "sketch"),
    "pad": ("features", "pad"),
    "pocket": ("features", "pocket"),
    "hole": ("features", "hole"),
    "fillet": ("features", "fillet"),
    "chamfer": ("features", "chamfer"),
    "linear_pattern": ("features", "linear_pattern"),
    "polar_pattern": ("features", "polar_pattern"),
    "mirror": ("features", "mirror"),
    "set": ("edit", "set_prop"),
    "delete": ("edit", "delete"),
    "rename": ("edit", "rename"),
    "link": ("..assembly", "link"),
    "import_step": ("..assembly", "import_step"),
    "joint": ("..assembly", "joint"),
    "require": ("..intent", "require"),
    "dfm_profile": ("..dfm.profile", "dfm_profile"),
}

OP_REGISTRY = {name: {"schema": SCHEMAS[name], "handler": _HANDLERS[name]} for name in OP_NAMES}


def handler_for(op: str) -> Callable[[Any, dict[str, Any]], None]:
    module, function = _HANDLERS[op]
    loaded = importlib.import_module(module, package=__name__) if module.startswith(".") else importlib.import_module(f"{__name__}.{module}")
    return getattr(loaded, function)
