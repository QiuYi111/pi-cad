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
    if spec.get("backend", "torch-fem") != "torch-fem":
        errors.append("backend must be torch-fem in V1")
    if spec.get("device", "auto") not in {"auto", "cpu", "cuda", "mps"}:
        errors.append("device must be one of auto, cpu, cuda, mps")

    artifact = spec.get("artifact")
    mesh = spec.get("mesh")
    if not artifact and not (mesh or {}).get("box"):
        errors.append("artifact or mesh.box is required")
    if artifact:
        artifact_path = Path(artifact)
        if not artifact_path.is_file():
            errors.append(f"artifact does not exist: {artifact}")
        elif artifact_path.suffix.lower() not in (".step", ".stp"):
            errors.append("artifact must be .step or .stp in V1")

    if (spec.get("physics") or {}).get("type") != "linear_elasticity":
        errors.append('physics.type must be "linear_elasticity"')

    materials = spec.get("materials")
    if not isinstance(materials, list) or len(materials) != 1:
        errors.append("materials must contain exactly one homogeneous material in V1")
    else:
        material = materials[0]
        try:
            E = float(material.get("E", material.get("youngs_modulus", 0)))
            nu = float(material.get("nu", material.get("poisson_ratio", 0)))
            if E <= 0 or not (0 <= nu < 0.5):
                errors.append("material requires E > 0 and 0 <= nu < 0.5")
        except (TypeError, ValueError):
            errors.append("material E and nu must be numeric")

    if not mesh:
        errors.append("mesh is required")
    else:
        try:
            size = float(mesh.get("size", 0))
            if size <= 0:
                errors.append("mesh.size must be > 0")
        except (TypeError, ValueError):
            errors.append("mesh.size must be numeric")
        if mesh.get("element") not in (None, "tet"):
            errors.append("mesh.element must be tet in V1")
        box = mesh.get("box")
        if box is not None and (
            not isinstance(box, (list, tuple))
            or len(box) != 3
            or any(not isinstance(value, (int, float)) or value <= 0 for value in box)
        ):
            errors.append("mesh.box must be three positive dimensions")

    def validate_region(value: Any, where: str) -> None:
        if not isinstance(value, dict):
            errors.append(f"{where}.region is required")
            return
        keys = set(value)
        if keys == {"indices"}:
            indices = value["indices"]
            if not isinstance(indices, list) or not indices or any(not isinstance(i, int) or i < 0 for i in indices):
                errors.append(f"{where}.region.indices must be non-negative node indices")
        elif keys == {"axis", "side"}:
            if value.get("axis") not in {"x", "y", "z"}:
                errors.append(f"{where}.region.axis must be x, y, or z")
            if value.get("side") not in {"min", "max"}:
                errors.append(f"{where}.region.side must be min or max")
        else:
            errors.append(f"{where}.region must contain either indices or exactly axis+side")

    loads = spec.get("loads")
    if not isinstance(loads, list) or not loads:
        errors.append("loads is required")
    else:
        for index, load in enumerate(loads or []):
            where = f"loads[{index}]"
            if load.get("type") != "nodal_force":
                errors.append(f"{where}.type must be nodal_force in V1")
            validate_region(load.get("region"), where)
            vector = load.get("vector")
            if not isinstance(vector, (list, tuple)) or len(vector) != 3 or any(not isinstance(v, (int, float)) for v in vector):
                errors.append(f"{where}.vector must be a numeric 3-vector")
            if load.get("distribute", "total") not in {"total", "per_node"}:
                errors.append(f"{where}.distribute must be total or per_node")

    constraints = spec.get("constraints")
    if not isinstance(constraints, list) or not constraints:
        errors.append("constraints is required")
    else:
        for index, constraint in enumerate(constraints or []):
            where = f"constraints[{index}]"
            if constraint.get("type") != "fixed":
                errors.append(f"{where}.type must be fixed in V1")
            validate_region(constraint.get("region"), where)
            dofs = constraint.get("dofs", [0, 1, 2])
            if not isinstance(dofs, list) or not dofs or any(d not in (0, 1, 2) for d in dofs):
                errors.append(f"{where}.dofs must be a non-empty subset of [0,1,2]")

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
