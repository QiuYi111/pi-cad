"""cad_simulate_flow backend: canonical FlowSpec -> SU2 -> canonical evidence.

Unit contract: CAD geometry per ``geometryUnits`` (mm default); every
physical quantity SI with the unit in its name. The mesh handed to SU2 is
in meters; results are SI.

The result reports raw fields, conservation balances, and convergence only.
It never states that a design passes, works, or is valid.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from .su2_backend import Su2UnavailableError, pre_hash_artifacts, run_su2, verify_unchanged
from .su2_config import compile_flow_cfg, write_cfg
from .su2_mesh import mesh_step_su2
from .su2_parse import (
    converged,
    fields_summary,
    marker_surface_stats,
    parse_history,
    read_su2_elements,
    read_volume_fields,
)

_SPEC_KEYS = {
    "analysisModel",
    "caseId",
    "artifact",
    "fluidDomain",
    "geometryUnits",
    "physics",
    "fluid",
    "boundaries",
    "mesh",
    "initial",
    "turbulenceInlet",
    "convergence",
}
_PHYSICS_KEYS = {"type", "turbulence"}
_FLUID_KEYS_IDEAL_GAS = {"model", "gamma", "gasConstantJPerKgK", "viscosity"}
_FLUID_KEYS_CONSTANT_DENSITY = {"model", "densityKgPerM3", "viscosity"}
_VISCOSITY_KEYS_CONSTANT = {"model", "muPas"}
_VISCOSITY_KEYS_SUTHERLAND = {"model", "muRefPas", "temperatureRefK", "sutherlandConstantK"}
# Euler is inviscid; every viscous solver requires an explicit contract.
_VISCOUS_PHYSICS = {"compressible_rans", "incompressible_ns", "incompressible_rans"}
_MESH_KEYS = {"maxSizeMm", "minSizeMm"}
_BOUNDARY_KEYS = {
    "type",
    "surfaces",
    "totalPressurePa",
    "totalTemperatureK",
    "flowDirection",
    "staticPressurePa",
    "velocityMPerS",
    "temperatureK",
    "thermal",
}
_THERMAL_KEYS = {"heatFluxWPerM2"}
_INITIAL_KEYS = {"mach", "temperatureK", "pressurePa", "velocityMPerS"}
_TURBULENCE_INLET_KEYS = {"intensity", "viscosityRatio"}
_CONVERGENCE_KEYS = {"maxIterations", "residualTarget"}


_ANALYSIS_MODEL_KEYS = {"derivationRef"}
_BOUNDARY_TYPES = ("total_conditions_inlet", "velocity_inlet", "pressure_outlet", "wall")


def _validate_analysis_model(spec: dict[str, Any], errors: list[str]) -> None:
    """Fail-closed validation of the analysisModel declaration (0.8 review P0-6).

    The declaration points at a harness-owned derivation record created by
    cad_derive_analysis_model — not a free-form {source, operations} claim.
    """
    model = spec.get("analysisModel")
    if model is None:
        return
    if not isinstance(model, dict):
        errors.append("analysisModel must be an object {derivationRef}")
        return
    _reject_unknown(model, _ANALYSIS_MODEL_KEYS, "analysisModel", errors)
    ref = model.get("derivationRef")
    if not isinstance(ref, str) or not ref.strip():
        errors.append("analysisModel.derivationRef is required (a cad_derive_analysis_model record path)")
    elif not Path(ref).is_file():
        errors.append(f"analysisModel.derivationRef does not exist: {ref}")


def _reject_unknown(obj: Any, allowed: set[str], where: str, errors: list[str]) -> None:
    if isinstance(obj, dict):
        unknown = sorted(set(obj) - allowed)
        if unknown:
            errors.append(f"{where} has unknown keys {unknown}; allowed keys are {sorted(allowed)}")


def _positive_number(obj: dict[str, Any], key: str, where: str, errors: list[str]) -> None:
    value = obj.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or float(value) <= 0:
        errors.append(f"{where}.{key} must be a number > 0")


def validate_flow_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    """Fail-closed schema validation (mirrors the harness tool schema)."""
    errors: list[str] = []
    if not isinstance(spec, dict):
        return False, ["spec must be an object"]
    _reject_unknown(spec, _SPEC_KEYS, "spec", errors)

    case_id = spec.get("caseId")
    if not isinstance(case_id, str) or not case_id.strip():
        errors.append("caseId is required (it binds the evidence obligation to this run)")

    fluid_domain = spec.get("fluidDomain")
    if not isinstance(fluid_domain, str) or not fluid_domain.strip():
        errors.append("fluidDomain is required: V1 flow needs an explicit watertight fluid-volume STEP")
    elif Path(fluid_domain).suffix.lower() not in (".step", ".stp"):
        errors.append("fluidDomain must be a .step/.stp fluid volume in V1")
    else:
        if not Path(fluid_domain).is_file():
            errors.append(f"fluidDomain does not exist: {fluid_domain}")

    artifact = spec.get("artifact")
    if artifact is not None:
        if not isinstance(artifact, str):
            errors.append("artifact must be a path string")
        elif Path(artifact).suffix.lower() not in (".step", ".stp"):
            errors.append("artifact must be .step or .stp in V1")
        elif not Path(artifact).is_file():
            errors.append(f"artifact does not exist: {artifact}")

    if spec.get("geometryUnits", "mm") not in ("mm", "m"):
        errors.append("geometryUnits must be mm or m in V1")

    _validate_analysis_model(spec, errors)

    physics = spec.get("physics")
    _reject_unknown(physics, _PHYSICS_KEYS, "physics", errors)
    physics_type = (physics or {}).get("type")
    if physics_type not in ("compressible_euler", "compressible_rans", "incompressible_ns", "incompressible_rans"):
        errors.append("physics.type must be one of compressible_euler, compressible_rans, incompressible_ns, incompressible_rans")
    turbulence = (physics or {}).get("turbulence")
    if physics_type in ("compressible_rans", "incompressible_rans"):
        if turbulence not in ("sa", "sst"):
            errors.append("RANS physics requires turbulence in {sa, sst}")
    elif turbulence is not None:
        errors.append("physics.turbulence is only valid for RANS physics")

    fluid = spec.get("fluid")
    if not isinstance(fluid, dict):
        errors.append("fluid is required")
    else:
        model = fluid.get("model")
        if model == "ideal_gas":
            _reject_unknown(fluid, _FLUID_KEYS_IDEAL_GAS, "fluid", errors)
            _positive_number(fluid, "gamma", "fluid", errors)
            _positive_number(fluid, "gasConstantJPerKgK", "fluid", errors)
        elif model == "constant_density":
            _reject_unknown(fluid, _FLUID_KEYS_CONSTANT_DENSITY, "fluid", errors)
            _positive_number(fluid, "densityKgPerM3", "fluid", errors)
        else:
            errors.append("fluid.model must be ideal_gas (compressible) or constant_density (incompressible)")
        if physics_type and model:
            compressible = physics_type.startswith("compressible_")
            if compressible and model != "ideal_gas":
                errors.append("compressible physics requires fluid.model= ideal_gas")
            if not compressible and model != "constant_density":
                errors.append("incompressible physics requires fluid.model= constant_density")
        # Viscosity is part of the canonical physical contract: viscous
        # solvers must declare it explicitly (no hidden air-Sutherland
        # default), and inviscid Euler must not carry one.
        viscosity = fluid.get("viscosity")
        if physics_type in _VISCOUS_PHYSICS:
            if not isinstance(viscosity, dict):
                errors.append(
                    f"{physics_type} requires fluid.viscosity with model constant "
                    "{{muPas}} or sutherland {{muRefPas, temperatureRefK, sutherlandConstantK}}"
                )
            elif viscosity.get("model") == "constant":
                _reject_unknown(viscosity, _VISCOSITY_KEYS_CONSTANT, "fluid.viscosity", errors)
                _positive_number(viscosity, "muPas", "fluid.viscosity", errors)
            elif viscosity.get("model") == "sutherland":
                _reject_unknown(viscosity, _VISCOSITY_KEYS_SUTHERLAND, "fluid.viscosity", errors)
                _positive_number(viscosity, "muRefPas", "fluid.viscosity", errors)
                _positive_number(viscosity, "temperatureRefK", "fluid.viscosity", errors)
                _positive_number(viscosity, "sutherlandConstantK", "fluid.viscosity", errors)
            else:
                errors.append("fluid.viscosity.model must be constant or sutherland")
        elif viscosity is not None:
            errors.append(f"fluid.viscosity is not applicable to {physics_type} (Euler is inviscid)")

    mesh = spec.get("mesh")
    if not isinstance(mesh, dict):
        errors.append("mesh is required")
    else:
        _reject_unknown(mesh, _MESH_KEYS, "mesh", errors)
        _positive_number(mesh, "maxSizeMm", "mesh", errors)
        if "minSizeMm" in mesh:
            _positive_number(mesh, "minSizeMm", "mesh", errors)

    initial = spec.get("initial")
    if isinstance(initial, dict):
        _reject_unknown(initial, _INITIAL_KEYS, "initial", errors)
    else:
        errors.append("initial is required (freestream state used to start the steady solve)")
    if physics_type and isinstance(initial, dict):
        if physics_type.startswith("compressible_"):
            for key in ("mach", "temperatureK", "pressurePa"):
                _positive_number(initial, key, "initial", errors)
        else:
            _positive_number(initial, "velocityMPerS", "initial", errors)

    turbulence_inlet = spec.get("turbulenceInlet")
    if turbulence_inlet is not None:
        if not isinstance(turbulence_inlet, dict):
            errors.append("turbulenceInlet must be an object")
        else:
            _reject_unknown(turbulence_inlet, _TURBULENCE_INLET_KEYS, "turbulenceInlet", errors)

    convergence = spec.get("convergence")
    if isinstance(convergence, dict):
        _reject_unknown(convergence, _CONVERGENCE_KEYS, "convergence", errors)
        if convergence.get("maxIterations") is not None and (
            not isinstance(convergence["maxIterations"], int) or convergence["maxIterations"] <= 0
        ):
            errors.append("convergence.maxIterations must be a positive integer")
        if convergence.get("residualTarget") is not None and (
            not isinstance(convergence["residualTarget"], (int, float)) or isinstance(convergence["residualTarget"], bool)
        ):
            errors.append("convergence.residualTarget must be a log10 residual number (e.g. -6)")

    boundaries = spec.get("boundaries")
    if not isinstance(boundaries, list) or not boundaries:
        errors.append("boundaries is required")
    else:
        physics_type = (physics or {}).get("type")
        compressible = str(physics_type or "").startswith("compressible_")
        for index, boundary in enumerate(boundaries):
            where = f"boundaries[{index}]"
            if not isinstance(boundary, dict):
                errors.append(f"{where} must be an object")
                continue
            _reject_unknown(boundary, _BOUNDARY_KEYS, where, errors)
            kind = boundary.get("type")
            if kind not in _BOUNDARY_TYPES:
                errors.append(f"{where}.type must be one of {list(_BOUNDARY_TYPES)}")
                continue
            surfaces = boundary.get("surfaces")
            if not isinstance(surfaces, list) or not surfaces or any(not isinstance(s, str) for s in surfaces):
                errors.append(f"{where}.surfaces must be a non-empty list of surface IDs")
            if kind == "total_conditions_inlet":
                if not compressible:
                    errors.append(f"{where}: total_conditions_inlet requires compressible physics in V1")
                _positive_number(boundary, "totalPressurePa", where, errors)
                _positive_number(boundary, "totalTemperatureK", where, errors)
                direction = boundary.get("flowDirection")
                if not isinstance(direction, list) or len(direction) != 3:
                    errors.append(f"{where}.flowDirection must be a 3-vector")
            elif kind == "velocity_inlet":
                if compressible:
                    errors.append(f"{where}: velocity_inlet requires incompressible physics in V1")
                _positive_number(boundary, "velocityMPerS", where, errors)
                _positive_number(boundary, "temperatureK", where, errors)
                direction = boundary.get("flowDirection")
                if not isinstance(direction, list) or len(direction) != 3:
                    errors.append(f"{where}.flowDirection must be a 3-vector")
            elif kind == "pressure_outlet":
                static_pressure = boundary.get("staticPressurePa")
                if not isinstance(static_pressure, (int, float)) or isinstance(static_pressure, bool):
                    errors.append(f"{where}.staticPressurePa must be a number (static; gauge when incompressible)")
            elif kind == "wall":
                thermal = boundary.get("thermal", "adiabatic")
                if thermal == "adiabatic":
                    pass
                elif isinstance(thermal, dict):
                    _reject_unknown(thermal, _THERMAL_KEYS, f"{where}.thermal", errors)
                    flux = thermal.get("heatFluxWPerM2")
                    if not isinstance(flux, (int, float)) or isinstance(flux, bool):
                        errors.append(f"{where}.thermal.heatFluxWPerM2 must be a number")
                    elif physics_type != "compressible_rans":
                        errors.append(f"{where}.thermal heat flux requires compressible_rans in V1")
                else:
                    errors.append(f"{where}.thermal must be 'adiabatic' or {{heatFluxWPerM2}}")
    return not errors, errors


def run_flow(spec_path: str | Path, output_dir: str | Path, stage: str = "run") -> dict[str, Any]:
    from .surface_selector import resolve_surface_ids

    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_flow_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))
    if stage == "validate":
        return {"status": "validated", "spec": str(spec_path), "errors": []}

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    fluid_domain = Path(spec["fluidDomain"]).resolve()
    geometry_units = spec.get("geometryUnits", "mm")
    mesh_spec = spec.get("mesh") or {}
    scale = {"mm": 1e-3, "m": 1.0}[geometry_units]
    max_size_model = float(mesh_spec["maxSizeMm"]) * 1e-3 / scale
    min_size_model = float(mesh_spec.get("minSizeMm", mesh_spec["maxSizeMm"] * 0.35)) * 1e-3 / scale

    # Both inputs are bound before the solve; either changing mid-run
    # invalidates the mesh/spec pairing.
    inputs = [fluid_domain]
    artifact_path = spec.get("artifact")
    if artifact_path:
        inputs.append(Path(artifact_path).resolve())
    pre_hashes = pre_hash_artifacts(inputs)

    try:
        mesh = mesh_step_su2(
            fluid_domain,
            output_dir / "fluid-domain.su2",
            geometry_units=geometry_units,
            max_size=max_size_model,
            min_size=min_size_model,
        )
    except Exception as exc:
        return {
            "status": "failed",
            "reason": f"fluid-domain meshing failed: {exc}",
            "caseId": spec.get("caseId"),
        }

    all_markers = sorted(mesh["markers"])
    # Resolve every referenced surface ID against this artifact version.
    try:
        requested = sorted({s for b in spec.get("boundaries") or [] for s in b.get("surfaces") or []})
        resolve_surface_ids(fluid_domain, requested)
    except ValueError as exc:
        return {"status": "failed", "reason": str(exc), "caseId": spec.get("caseId")}

    nodes = np.asarray(mesh["nodes"], dtype=np.float64)
    extents = nodes.max(axis=0) - nodes.min(axis=0)
    domain_length = float(max(extents.max(), 1e-9))

    try:
        cfg_text = compile_flow_cfg(spec, "fluid-domain.su2", domain_length, all_markers)
    except ValueError as exc:
        return {"status": "failed", "reason": str(exc), "caseId": spec.get("caseId")}
    write_cfg(cfg_text, output_dir / "case.cfg")

    try:
        run = run_su2(output_dir / "case.cfg", output_dir)
    except Su2UnavailableError as exc:
        return {
            "status": "unavailable",
            "reason": str(exc),
            "capability": {"backend": "su2"},
            "caseId": spec.get("caseId"),
        }
    if run["exitCode"] != 0:
        return {
            "status": "failed",
            "reason": f"SU2_CFD exited with code {run['exitCode']}",
            "stderr": run["stderr"][-2000:],
            "caseId": spec.get("caseId"),
        }

    try:
        verify_unchanged(pre_hashes)
    except Exception as exc:
        # Provenance violation: the result is discarded and must surface as an
        # error envelope so no evidence can be recorded from it.
        return {"status": "discarded", "reason": str(exc), "caseId": spec.get("caseId")}

    try:
        history = parse_history(output_dir / "history.csv")
        points, fields = read_volume_fields(output_dir / "vol_solution.vtu")
    except Exception as exc:
        return {
            "status": "failed",
            "reason": f"could not parse SU2 output: {exc}",
            "stderr": run["stderr"][-2000:],
            "caseId": spec.get("caseId"),
        }

    residual_target = (spec.get("convergence") or {}).get("residualTarget")
    # Execution validity is the interpreter's call, not the Agent's: a run
    # that did not meet its own declared residual standard (or declared no
    # standard at all) is "not_converged". Its raw fields are still returned
    # for inspection, but the harness records no simulation evidence from a
    # not_converged run, so it can never close a required case.
    is_converged = converged(history, residual_target)
    if not is_converged:
        status = "not_converged"
        if residual_target is None:
            not_converged_reason = (
                "no convergence.residualTarget was declared; a run only qualifies as "
                "evidence when it declares and meets a residual standard"
            )
        else:
            not_converged_reason = (
                f"worst RMS residual log10 {history.get('worstResidualLog10')} did not reach "
                f"the declared target {residual_target} within the iteration budget"
            )
    else:
        status = "solved"
        not_converged_reason = None

    marker_nodes: dict[str, set[int]] = {}
    marker_stats: dict[str, Any] = {}
    elements = read_su2_elements(mesh["meshPath"])
    for marker, stats in mesh["markers"].items():
        triangles = stats["triangles"]
        marker_nodes[marker] = {v for tri in triangles for v in tri}
        marker_stats[marker] = marker_surface_stats(nodes, elements, triangles, fields)

    def boundary_surfaces(kind: str) -> list[str]:
        return [s for b in spec.get("boundaries") or [] if b["type"] == kind for s in b.get("surfaces") or []]

    inlet_flow = sum(
        marker_stats.get(surface, {}).get("massFlowKgPerS", 0.0)
        for surface in boundary_surfaces("total_conditions_inlet") + boundary_surfaces("velocity_inlet")
    )
    outlet_flow = sum(
        marker_stats.get(surface, {}).get("massFlowKgPerS", 0.0)
        for surface in boundary_surfaces("pressure_outlet")
    )
    net = inlet_flow + outlet_flow  # outlet normals point outward => negative
    imbalance = abs(net) / max(abs(inlet_flow), 1e-12)

    visualization: dict[str, Any] = {"status": "unavailable", "views": []}
    try:
        from .su2_visualization import render_su2_views

        field_name = "Mach" if "Mach" in fields else next(iter(fields))
        visualization = render_su2_views(
            nodes,
            elements,
            [tri for stats in mesh["markers"].values() for tri in stats["triangles"]],
            fields,
            output_dir / "visualization",
            field_name=field_name,
        )
        visualization["status"] = "ready"
    except Exception as exc:
        visualization["reason"] = str(exc)

    fields_path = output_dir / "flow-fields.npz"
    np.savez_compressed(fields_path, nodes=nodes, **{k: v for k, v in fields.items() if v.ndim == 1})

    result = {
        "status": status,
        **({"reason": not_converged_reason} if not_converged_reason else {}),
        "caseId": spec.get("caseId"),
        "backend": "su2",
        "backendVersion": run["version"],
        "su2Binary": run["binary"],
        "units": "SI",
        "mesh": {
            "nodeCount": mesh["nodeCount"],
            "elementCount": mesh["elementCount"],
            "elementType": mesh["elementType"],
            "meshSizeMax": mesh_spec.get("maxSizeMm"),
            "geometryUnits": geometry_units,
            "generator": mesh["generator"],
        },
        "convergence": {
            "reached": bool(is_converged),
            "residualTargetLog10": residual_target,
            "iterations": history["iterations"],
            "finalResidualsLog10": history["finalResidualsLog10"],
            "worstResidualLog10": history["worstResidualLog10"],
        },
        "massBalance": {
            "inletKgPerS": round(inlet_flow, 9),
            "outletKgPerS": round(outlet_flow, 9),
            "relativeImbalance": round(imbalance, 9),
        },
        "boundaries": {
            marker: {k: v for k, v in stats.items() if k != "triangles"}
            for marker, stats in marker_stats.items()
        },
        "fields": fields_summary(fields),
        "visualization": visualization,
        "interpretationPolicy": "raw deterministic fields and balances only; engineering judgment is the Agent's",
    }
    result_path = output_dir / "flow-result.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["artifact"] = str(result_path)
    result["fieldArtifacts"] = [str(fields_path)]
    return result
