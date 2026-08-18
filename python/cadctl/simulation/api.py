from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .base import SimulationBackendError
from .torch_fem_backend import TorchFemBackend


def validate_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not spec.get("artifact") and not ((spec.get("mesh") or {}).get("box")):
        errors.append("artifact or mesh.box is required")
    if (spec.get("physics") or {}).get("type") != "linear_elasticity":
        errors.append('physics.type must be "linear_elasticity"')
    if not spec.get("materials"):
        errors.append("materials is required")
    if not spec.get("loads"):
        errors.append("loads is required")
    if not spec.get("constraints"):
        errors.append("constraints is required")
    if not spec.get("mesh"):
        errors.append("mesh is required")
    return not errors, errors


def run_simulation(spec_path: str | Path, output_dir: str | Path, stage: str = "run") -> dict[str, Any]:
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))
    if stage == "validate":
        return {"status": "validated", "spec": str(spec_path), "errors": []}
    try:
        result = TorchFemBackend().solve(spec, output_dir)
    except SimulationBackendError as exc:
        return {
            "status": "unavailable",
            "spec": str(spec_path),
            "reason": str(exc),
            "capability": {"backend": "torch-fem"},
        }
    return {"status": "solved", **result}
