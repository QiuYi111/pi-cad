from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .base import SimulationBackendError
from .torch_fem_backend import TorchFemBackend


def validate_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if spec.get("units", "mm_N_MPa") != "mm_N_MPa":
        errors.append("units must be mm_N_MPa in V1 (length=mm, force=N, stress/modulus=MPa)")
    if not spec.get("artifact") and not ((spec.get("mesh") or {}).get("box")):
        errors.append("artifact or mesh.box is required")
    if (spec.get("physics") or {}).get("type") != "linear_elasticity":
        errors.append('physics.type must be "linear_elasticity"')
    if not spec.get("materials"):
        errors.append("materials is required")
    loads = spec.get("loads")
    if not loads:
        errors.append("loads is required")
    else:
        for index, load in enumerate(loads or []):
            if load.get("type") != "nodal_force":
                errors.append(
                    f"loads[{index}].type={load.get('type')!r} is unsupported; V1 supports only nodal_force"
                )
            vector = load.get("vector")
            if not isinstance(vector, (list, tuple)) or len(vector) != 3:
                errors.append(f"loads[{index}].vector must be a 3-vector")
    constraints = spec.get("constraints")
    if not constraints:
        errors.append("constraints is required")
    else:
        for index, constraint in enumerate(constraints or []):
            if constraint.get("type") != "fixed":
                errors.append(
                    f"constraints[{index}].type={constraint.get('type')!r} is unsupported; V1 supports only fixed"
                )
    mesh = spec.get("mesh")
    if not mesh:
        errors.append("mesh is required")
    elif mesh.get("element") not in (None, "tet"):
        errors.append("mesh.element must be tet in V1")
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
