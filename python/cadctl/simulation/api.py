from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..common import read_json, resolve_spec_path

from .base import SimulationBackendError
from .torch_fem_backend import TorchFemBackend

# Key whitelists: the V2 manifest/harness rejects unknown keys, and the
# Recipe-owned solver library must independently fail closed as well. A typo
# like "distribut" or "dof" must never silently fall back to a default.
_SPEC_KEYS = {
    "units",
    "backend",
    "device",
    "artifact",
    "analysisModel",
    "physics",
    "mesh",
    "materials",
    "constraints",
    "loads",
    "sensitivity",
}
_ANALYSIS_MODEL_KEYS = {"derivationRef"}
_PHYSICS_KEYS = {"type"}
_MATERIAL_KEYS = {"name", "E", "nu", "density", "youngs_modulus", "poisson_ratio"}
_MESH_KEYS = {"element", "size", "box"}
_LOAD_KEYS = {"type", "region", "vector", "distribute"}
_CONSTRAINT_KEYS = {"type", "region", "dofs"}
_SENSITIVITY_KEYS = {"type"}


def _reject_unknown_keys(obj: Any, allowed: set[str], where: str, errors: list[str]) -> None:
    if isinstance(obj, dict):
        unknown = sorted(set(obj) - allowed)
        if unknown:
            errors.append(f"{where} has unknown keys {unknown}; allowed keys are {sorted(allowed)}")


def validate_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(spec, dict):
        return False, ["spec must be an object"]
    _reject_unknown_keys(spec, _SPEC_KEYS, "spec", errors)
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
    if artifact and (mesh or {}).get("box"):
        errors.append("artifact and mesh.box are mutually exclusive in V1; the ignored one would silently change the mesh source")
    if artifact:
        artifact_path = Path(artifact)
        if not artifact_path.is_file():
            errors.append(f"artifact does not exist: {artifact}")
        elif artifact_path.suffix.lower() not in (".step", ".stp"):
            errors.append("artifact must be .step or .stp in V1")

    # Analysis-model derivation (0.8 review P0-3): a fused/bonded assembly
    # handed to solid FEA must carry a harness-owned derivation record, not
    # a free-form claim. Same contract as flow/thermal.
    model = spec.get("analysisModel")
    if model is not None:
        if not isinstance(model, dict):
            errors.append("analysisModel must be an object {derivationRef}")
        else:
            _reject_unknown_keys(model, _ANALYSIS_MODEL_KEYS, "analysisModel", errors)
            ref = model.get("derivationRef")
            if not isinstance(ref, str) or not ref.strip():
                errors.append("analysisModel.derivationRef is required (a cad_derive_analysis_model record path)")
            elif not Path(ref).is_file():
                errors.append(f"analysisModel.derivationRef does not exist: {ref}")

    physics = spec.get("physics")
    _reject_unknown_keys(physics, _PHYSICS_KEYS, "physics", errors)
    if (physics or {}).get("type") != "linear_elasticity":
        errors.append('physics.type must be "linear_elasticity"')

    materials = spec.get("materials")
    if not isinstance(materials, list) or len(materials) != 1:
        errors.append("materials must contain exactly one homogeneous material in V1")
    else:
        material = materials[0]
        _reject_unknown_keys(material, _MATERIAL_KEYS, "materials[0]", errors)
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
        _reject_unknown_keys(mesh, _MESH_KEYS, "mesh", errors)
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
            _reject_unknown_keys(load, _LOAD_KEYS, where, errors)
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
            _reject_unknown_keys(constraint, _CONSTRAINT_KEYS, where, errors)
            if constraint.get("type") != "fixed":
                errors.append(f"{where}.type must be fixed in V1")
            validate_region(constraint.get("region"), where)
            dofs = constraint.get("dofs", [0, 1, 2])
            if not isinstance(dofs, list) or not dofs or any(d not in (0, 1, 2) for d in dofs):
                errors.append(f"{where}.dofs must be a non-empty subset of [0,1,2]")

    sensitivity = spec.get("sensitivity")
    if sensitivity is not None:
        _reject_unknown_keys(sensitivity, _SENSITIVITY_KEYS, "sensitivity", errors)
        if not isinstance(sensitivity, dict) or sensitivity.get("type") != "compliance_by_youngs_modulus":
            errors.append("sensitivity.type must be compliance_by_youngs_modulus")

    return not errors, errors


def run_simulation(spec_path: str | Path, output_dir: str | Path, stage: str = "run") -> dict[str, Any]:
    spec_path = Path(spec_path)
    spec = read_json(spec_path, normalize_paths=True)
    if spec.get("artifact"):
        spec["artifact"] = str(resolve_spec_path(spec_path, spec["artifact"]))
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
