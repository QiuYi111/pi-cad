"""Small, semantics-free helpers for writing Pi-CAD Observation wire JSON."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def export(exports: Mapping[str, Mapping[str, Any]], destination: str | Path | None = None) -> Path:
    """Write a schema-1 Observation bundle without interpreting export names."""

    raw_destination = str(destination) if destination is not None else os.environ.get("PI_SIM_OBSERVATION_FILE")
    if not raw_destination:
        raise RuntimeError("PI_SIM_OBSERVATION_FILE is not set and no destination was provided")
    target = Path(raw_destination)
    if not exports or any(not isinstance(name, str) or not name for name in exports):
        raise ValueError("exports must be a non-empty mapping with non-empty string names")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"schema": 1, "exports": dict(exports)}, indent=2) + "\n", encoding="utf-8")
    return target


__all__ = ["export"]
